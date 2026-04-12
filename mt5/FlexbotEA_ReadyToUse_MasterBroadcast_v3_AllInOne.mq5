//+------------------------------------------------------------------+
//| FlexbotEA_ReadyToUse_MasterBroadcast_v2_FIXStops_RejectInvalidSL.mq5 |
//| (Based on FlexbotSignalEA v9)                                    |
//|                                                                  |
//| Purpose: Poll /signal/next and trade once, without log-spam.      |
//|                                                                  |
//| IMPORTANT FIX (SL/TP reliability / multi-account):               |
//| - After trade.Buy/Sell, DO NOT use trade.ResultOrder() as        |
//|   position ticket. That is an ORDER ticket.                      |
//| - Find the opened POSITION by symbol+magic and modify stops using|
//|   the POSITION_TICKET (especially critical on hedging accounts). |
//|                                                                  |
//| Other fixes retained:                                            |
//| - /signal/next includes account_login + server                   |
//| - since_ms GlobalVariable is per-account (login+server)          |
//+------------------------------------------------------------------+
#property strict


#include <Trade/Trade.mqh>
CTrade trade;

// ===== Inputs =====
input string InpBaseUrl = "https://flexbot-qpf2.onrender.com";
input string InpSymbol = "XAUUSD";
input double InpRiskPercent = 1.0; // requested risk % (legacy; used only by CalcRiskLots)
input double MaxRiskPercent = 1.0; // hard cap (legacy)

// ===== Price Pusher + Seed =====
input bool   InpEnablePricePush = true;   // Push live bid/ask to server
input int    InpPricePushMs     = 1000;   // Throttle price push (ms)
input bool   InpDoSeed          = true;   // Seed M15 history on startup
input int    InpSeedTargetM15   = 96;     // How many M15 bars to seed
input int    InpSeedBatchSize   = 32;
input int    InpSeedTimeoutMs   = 15000;
input int    InpSeedRetrySec    = 30;
input int    InpSeedMinBars     = 10;

// Lotsize
input bool InpUseFixedLot = false; // AUTO (recommended): lot size from SL distance so risk <= InpMaxRiskPercent
input double InpFixedLot = 1.0;  // (unused when InpUseFixedLot=false)

// Risk gate: only open trades when risk with InpFixedLot is <= this %
input double InpMaxRiskPercent = 0.5; // max risk per trade (AUTO lots). FTMO-safe: 0.5% risk.
input double InpMaxLot = 1.0; // HARD CAP lotsize (ready for users). Never exceed 1.0 lot.

// Legacy scaling rule (only used if you re-enable it in code):
// lots = (equity / 100000) * InpLotPer100k
input double InpLotPer100k = 1.0;

input double RR = 1.5; // fixed Risk:Reward for TP

input int InpPollSeconds = 30; // reduce polling spam
input ulong InpMagic = 8210317741;

// EA -> backend live status
input string InpEaApiKey = ""; // same as Render env EA_API_KEY
input int InpStatusPostSeconds = 30; // throttle POST /ea/status

input bool InpEnableExecPost = true;

// Reject impossible signals so EA doesn't loop forever on the same one
input bool InpEnableRejectPost = true; // POST /signal/reject when we skip (e.g. invalid SL)

// CLOSE recap posting
input bool InpEnableClosePost = true;  // POST /signal/closed after trade closes
input string InpSignalSecret = "";     // SIGNAL_SECRET for /signal/closed (keep private)

input bool InpDebugHttp = true;
input bool InpDebugTrade = true;

// On-chart banner
input bool   InpEnableBanner = true;
// input string InpBannerIconFile = "flexbot_banner_icon.bmp"; // disabled: no image

// Safety
input bool InpBlockSameDirection = true;
input int InpCooldownMinutes = 30;

// Prop / FTMO guard
// Daily loss (banner) is measured on BALANCE: (DayStartBalance - currentBalance) / DayStartBalance.
// Reset time is at midnight for an offset from GMT (default: NL winter time = +1). Set to +2 in summer time.
input int    InpDailyResetGmtOffsetHours = 1;
input double InpMaxDailyLossPercent = 4.0;
input bool   InpDailyLossClosePositions = true;

// Execution / slippage protection
input int MaxSpreadPoints = 120; // 0 disables
input int MaxSlippagePoints = 30;
input int MaxEntryDistancePoints = 60;

// FTMO / sanity guards
input int MinSLDistancePoints = 300;
input int MinTPDistancePoints = 300;

// ===== Trade Management (Echo: BE at 1.3R, Trail at 1.0R) =====
input bool   InpEnableBreakEven   = true;   // Move SL to entry when profit reaches BE threshold
input double InpBreakEvenPct      = 39.4;   // % of TP distance to trigger BE (1.3R/3.3R = 39.4%)
input double InpBreakEvenBuffer   = 0.25;   // Buffer above entry for BE (spread)
input bool   InpEnableTrailing    = true;   // Trail SL behind price after BE
input double InpTrailStartPct     = 39.4;   // % of TP distance to start trailing (same as BE)
input double InpTrailDistPoints   = 0;      // Fixed trail points (0 = use R-based: trail dist = SL dist)
input double InpTrailDistR        = 1.0;    // Trail distance as R-multiple (used when TrailDistPoints=0)

// ===== On-chart banner (lightweight) =====
string BannerPrefix(){ return "FLEXBOT_BANNER_" + InpSymbol + "_" + (string)InpMagic; }
string BannerRectName(){ return BannerPrefix() + "_RECT"; }
string BannerIconName(){ return BannerPrefix() + "_ICON"; }
string BannerLineName(const int i){ return BannerPrefix() + "_LINE" + (string)i; }
string BannerConnName(){ return BannerPrefix() + "_CONN"; }

int g_lastBannerPeriod = 0;

void CleanupBannerAllOnChart()
{
  long cid = ChartID();
  int total = ObjectsTotal(cid, 0, -1);
  for(int i=total-1; i>=0; i--) {
    string name = ObjectName(cid, i, 0, -1);
    if(StringFind(name, "FLEXBOT_BANNER_") == 0) {
      ObjectDelete(cid, name);
    }
  }
}

void EnsureBannerObjects() {
  if(!InpEnableBanner) return;
  long cid = ChartID();

  // If timeframe changed, MT5 can leave duplicate labels. Clean once per change.
  int p = Period();
  if(g_lastBannerPeriod == 0) g_lastBannerPeriod = p;
  if(p != g_lastBannerPeriod) {
    CleanupBannerAllOnChart();
    g_lastBannerPeriod = p;
  }

  const int x0 = 10;
  const int y0 = 18;
  const int w0 = 560;

  if(ObjectFind(cid, BannerRectName()) < 0) {
    ObjectCreate(cid, BannerRectName(), OBJ_RECTANGLE_LABEL, 0, 0, 0);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_CORNER, CORNER_LEFT_UPPER);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_XDISTANCE, x0);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_YDISTANCE, y0);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_XSIZE, w0);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_YSIZE, 84);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_COLOR, clrNONE);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_BGCOLOR, clrBlack);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_BORDER_TYPE, BORDER_FLAT);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_BACK, false);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_SELECTABLE, false);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_HIDDEN, true);
  }

  // Icon disabled (no image resource)

  for(int i=1;i<=3;i++) {
    string n = BannerLineName(i);
    if(ObjectFind(cid, n) < 0) {
      ObjectCreate(cid, n, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(cid, n, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(cid, n, OBJPROP_XDISTANCE, x0 + 10);
      ObjectSetInteger(cid, n, OBJPROP_FONTSIZE, 12);
      ObjectSetString(cid, n, OBJPROP_FONT, "Segoe UI");
      ObjectSetInteger(cid, n, OBJPROP_COLOR, clrWhite);
      ObjectSetInteger(cid, n, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(cid, n, OBJPROP_HIDDEN, true);
      ObjectSetString(cid, n, OBJPROP_TEXT, ""); // prevent default "Label"
    }
  }
  ObjectSetInteger(cid, BannerLineName(1), OBJPROP_YDISTANCE, y0 + 8);
  ObjectSetInteger(cid, BannerLineName(2), OBJPROP_YDISTANCE, y0 + 28);
  ObjectSetInteger(cid, BannerLineName(3), OBJPROP_YDISTANCE, y0 + 48);

  // Connection label top-right inside the banner
  if(ObjectFind(cid, BannerConnName()) < 0) {
    ObjectCreate(cid, BannerConnName(), OBJ_LABEL, 0, 0, 0);
    ObjectSetInteger(cid, BannerConnName(), OBJPROP_CORNER, CORNER_LEFT_UPPER);
    ObjectSetInteger(cid, BannerConnName(), OBJPROP_ANCHOR, ANCHOR_RIGHT_UPPER);
    ObjectSetInteger(cid, BannerConnName(), OBJPROP_FONTSIZE, 12);
    ObjectSetString(cid, BannerConnName(), OBJPROP_FONT, "Segoe UI");
    ObjectSetInteger(cid, BannerConnName(), OBJPROP_SELECTABLE, false);
    ObjectSetInteger(cid, BannerConnName(), OBJPROP_HIDDEN, true);
    ObjectSetString(cid, BannerConnName(), OBJPROP_TEXT, "");
  }
  ObjectSetInteger(cid, BannerConnName(), OBJPROP_XDISTANCE, x0 + w0 - 10);
  ObjectSetInteger(cid, BannerConnName(), OBJPROP_YDISTANCE, y0 + 8);
}

void SetBanner(const string l1, const string l2, const string l3) {
  if(!InpEnableBanner) return;
  EnsureBannerObjects();
  long cid = ChartID();
  ObjectSetString(cid, BannerLineName(1), OBJPROP_TEXT, l1);
  ObjectSetString(cid, BannerLineName(2), OBJPROP_TEXT, l2);
  ObjectSetString(cid, BannerLineName(3), OBJPROP_TEXT, l3);

  ObjectSetInteger(cid, BannerConnName(), OBJPROP_COLOR, g_connOk ? clrLime : clrRed);
  ObjectSetString(cid, BannerConnName(), OBJPROP_TEXT, g_connOk ? "CONNECTED" : "DISCONNECTED");
}

void RemoveBanner() {
  long cid = ChartID();
  ObjectDelete(cid, BannerRectName());
  ObjectDelete(cid, BannerIconName());
  ObjectDelete(cid, BannerLineName(1));
  ObjectDelete(cid, BannerLineName(2));
  ObjectDelete(cid, BannerLineName(3));
  ObjectDelete(cid, BannerConnName());
}

// ===== Price Pusher State =====
datetime g_nextSeedTry = 0;
bool     g_seedDone = false;
ulong    g_lastPricePushMs = 0;

// ===== Trade Management State =====
bool   g_breakEvenDone = false;  // already moved SL to break-even for current position

// ===== Internal =====
bool g_connOk = false;
ulong g_lastPollMs = 0;
string g_lastSignalId = "";
string g_lastSeenId = ""; // legacy (do not use for consuming; kept for backward compatibility)
string g_lastAttemptId = "";
ulong  g_lastAttemptTick = 0;
long g_sinceMs = 0;
long g_lastOpenMs = 0;

// Close recap state
datetime g_lastCloseDealTime = 0;
string g_lastClosedSignalId = "";

// Persist signal id across restarts (so /signal/closed still works after MT5/EA restart)
string g_persistedSignalId = "";
string g_persistedClosedSignalId = "";

// Daily loss guard
bool g_dailyStop = false;
int g_dailyYmd = 0;
double g_dayStartEquity = 0.0;
double g_dayStartBalance = 0.0;

// Cooldown reporting to backend
bool g_cdReportedActive = false;
long g_cdReportedUntilMs = 0;
long g_cdLastPostMs = 0;

// ---------- helpers ----------
string Trim(const string s){ string r=s; StringTrimLeft(r); StringTrimRight(r); return r; }
long NowMsUtc(){ return (long)TimeGMT() * 1000; }

// ---- FIX helpers ----
string SanitizeKey(const string s)
{
  string out = "";
  for(int i=0;i<StringLen(s);i++){
    ushort c = StringGetCharacter(s,i);
    if((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'||c=='-'||c=='.')
      out += (string)CharToString((uchar)c);
    else
      out += "_";
  }
  return out;
}

string UrlEncode(const string s)
{
  string out = "";
  for(int i=0;i<StringLen(s);i++){
    ushort c = StringGetCharacter(s,i);
    if((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='_'||c=='.'||c=='~'){
      out += (string)CharToString((uchar)c);
    } else if(c==' ') {
      out += "%20";
    } else {
      out += StringFormat("%%%02X", (int)c);
    }
  }
  return out;
}

// ---- FIX: since key per account ----
string GVNameSince(){
  long login = AccountInfoInteger(ACCOUNT_LOGIN);
  string srv = SanitizeKey(AccountInfoString(ACCOUNT_SERVER));
  return "flexbot_since_ms_" + InpSymbol + "_" + (string)login + "_" + srv;
}

string GVNameDayStartEq(){ return "flexbot_daystart_eq_" + InpSymbol + "_" + (string)InpMagic; }
string GVNameDayStartBal(){ return "flexbot_daystart_bal_" + InpSymbol + "_" + (string)InpMagic; }
string GVNameDayYmd(){ return "flexbot_day_ymd_" + InpSymbol + "_" + (string)InpMagic; }

string PersistFileName(){ return "flexbot_state_" + InpSymbol + "_" + (string)InpMagic + ".txt"; }
string PosMapFileName(){ return "flexbot_posmap_" + InpSymbol + "_" + (string)InpMagic + ".txt"; }

void PosMapSet(const ulong posId, const string sigId)
{
  if(posId==0 || Trim(sigId)=="") return;
  int h = FileOpen(PosMapFileName(), FILE_READ|FILE_WRITE|FILE_TXT|FILE_ANSI);
  if(h == INVALID_HANDLE) {
    // create new
    h = FileOpen(PosMapFileName(), FILE_WRITE|FILE_TXT|FILE_ANSI);
    if(h == INVALID_HANDLE) { Print("PosMap: FileOpen failed err=", GetLastError()); return; }
    FileWriteString(h, (string)posId + "=" + sigId + "\n");
    FileClose(h);
    return;
  }

  // Load existing lines
  string lines[512];
  int n=0;
  while(!FileIsEnding(h) && n<512) {
    string line = FileReadString(h);
    if(Trim(line)!="") lines[n++] = line;
  }
  FileClose(h);

  bool replaced=false;
  string key = (string)posId + "=";
  for(int i=0;i<n;i++) {
    if(StringFind(lines[i], key)==0) {
      lines[i] = key + sigId;
      replaced=true;
      break;
    }
  }

  int hw = FileOpen(PosMapFileName(), FILE_WRITE|FILE_TXT|FILE_ANSI);
  if(hw == INVALID_HANDLE) { Print("PosMap: FileOpen write failed err=", GetLastError()); return; }
  for(int i=0;i<n;i++) FileWriteString(hw, lines[i] + "\n");
  if(!replaced) FileWriteString(hw, key + sigId + "\n");
  FileClose(hw);
}

bool PosMapGet(const ulong posId, string &sigIdOut)
{
  sigIdOut = "";
  if(posId==0) return false;
  int h = FileOpen(PosMapFileName(), FILE_READ|FILE_TXT|FILE_ANSI);
  if(h == INVALID_HANDLE) return false;
  string key = (string)posId + "=";
  while(!FileIsEnding(h)) {
    string line = FileReadString(h);
    if(StringFind(line, key)==0) {
      sigIdOut = Trim(StringSubstr(line, StringLen(key)));
      FileClose(h);
      return (Trim(sigIdOut)!="");
    }
  }
  FileClose(h);
  return false;
}

void PersistSaveSignalId(const string id) {
  g_persistedSignalId = id;
  int h = FileOpen(PersistFileName(), FILE_WRITE|FILE_TXT|FILE_ANSI);
  if(h == INVALID_HANDLE) { Print("Persist: FileOpen save failed err=", GetLastError()); return; }
  FileWriteString(h, "signal_id=" + g_persistedSignalId + "\n");
  FileWriteString(h, "closed_signal_id=" + g_persistedClosedSignalId + "\n");
  FileClose(h);
}

void PersistSaveClosedSignalId(const string id) {
  g_persistedClosedSignalId = id;
  int h = FileOpen(PersistFileName(), FILE_WRITE|FILE_TXT|FILE_ANSI);
  if(h == INVALID_HANDLE) { Print("Persist: FileOpen save failed err=", GetLastError()); return; }
  FileWriteString(h, "signal_id=" + g_persistedSignalId + "\n");
  FileWriteString(h, "closed_signal_id=" + g_persistedClosedSignalId + "\n");
  FileClose(h);
}

void PersistLoad() {
  g_persistedSignalId = "";
  g_persistedClosedSignalId = "";
  int h = FileOpen(PersistFileName(), FILE_READ|FILE_TXT|FILE_ANSI);
  if(h == INVALID_HANDLE) return;
  while(!FileIsEnding(h)) {
    string line = FileReadString(h);
    if(StringFind(line, "signal_id=") == 0) g_persistedSignalId = Trim(StringSubstr(line, StringLen("signal_id=")));
    if(StringFind(line, "closed_signal_id=") == 0) g_persistedClosedSignalId = Trim(StringSubstr(line, StringLen("closed_signal_id=")));
  }
  FileClose(h);
}

// -------- POSITION HELPERS (critical for SL/TP reliability) --------
ulong FindMyPositionTicket(const string sym, const ulong magic)
{
  for(int i=PositionsTotal()-1; i>=0; i--)
  {
    ulong t = PositionGetTicket(i);
    if(t==0) continue;
    if(!PositionSelectByTicket(t)) continue;
    if(PositionGetString(POSITION_SYMBOL) != sym) continue;
    if((ulong)PositionGetInteger(POSITION_MAGIC) != magic) continue;
    return t; // POSITION_TICKET
  }
  return 0;
}

bool WaitForMyPosition(const string sym, const ulong magic, ulong &posTicketOut, const int tries=10, const int sleepMs=150)
{
  posTicketOut = 0;
  for(int k=0; k<tries; k++)
  {
    posTicketOut = FindMyPositionTicket(sym, magic);
    if(posTicketOut != 0) return true;
    Sleep(sleepMs);
  }
  return false;
}

int ResetYmdByGmtOffset() {
  datetime t = TimeGMT() + (InpDailyResetGmtOffsetHours * 3600);
  MqlDateTime dt;
  TimeToStruct(t, dt);
  return dt.year*10000 + dt.mon*100 + dt.day;
}

datetime DayStartServerTimeByGmtOffset()
{
  int offsetSec = InpDailyResetGmtOffsetHours * 3600;
  int serverOffsetSec = (int)(TimeCurrent() - TimeGMT());

  datetime gmtNow = TimeGMT();
  datetime offNow = gmtNow + offsetSec;

  MqlDateTime dt;
  TimeToStruct(offNow, dt);
  int secSinceMidnight = dt.hour*3600 + dt.min*60 + dt.sec;

  datetime midnightOff_GMT = gmtNow - secSinceMidnight;
  return midnightOff_GMT + serverOffsetSec;
}

double NetClosedDealsSince(const datetime fromTs)
{
  double net = 0.0;
  datetime toTs = TimeCurrent();
  if(!HistorySelect(fromTs, toTs)) return 0.0;

  int total = (int)HistoryDealsTotal();
  for(int i=0; i<total; i++) {
    ulong deal = HistoryDealGetTicket(i);
    if(deal == 0) continue;
    if(!HistoryDealSelect(deal)) continue;

    long entry = HistoryDealGetInteger(deal, DEAL_ENTRY);
    if(entry != DEAL_ENTRY_OUT) continue;

    double profit = HistoryDealGetDouble(deal, DEAL_PROFIT);
    double swap   = HistoryDealGetDouble(deal, DEAL_SWAP);
    double comm   = HistoryDealGetDouble(deal, DEAL_COMMISSION);
    net += (profit + swap + comm);
  }
  return net;
}

double CalcStartBalanceToday()
{
  double balNow = AccountInfoDouble(ACCOUNT_BALANCE);
  datetime dayStart = DayStartServerTimeByGmtOffset();
  double netClosed = NetClosedDealsSince(dayStart);

  if(InpDebugHttp) {
    static bool printed=false;
    if(!printed) {
      printed=true;
      Print("PnL baseline window from=", TimeToString(dayStart, TIME_DATE|TIME_MINUTES),
            " serverNow=", TimeToString(TimeCurrent(), TIME_DATE|TIME_MINUTES),
            " netClosed=", DoubleToString(netClosed,2),
            " balNow=", DoubleToString(balNow,2));
    }
  }

  return balNow - netClosed;
}

void LoadOrResetDayStartEquity() {
  int ymd = ResetYmdByGmtOffset();
  if(ymd != g_dailyYmd) {
    g_dailyYmd = ymd;
    g_dailyStop = false;

    g_dayStartBalance = CalcStartBalanceToday();
    g_dayStartEquity  = g_dayStartBalance;

    GlobalVariableSet(GVNameDayStartBal(), g_dayStartBalance);
    GlobalVariableSet(GVNameDayStartEq(),  g_dayStartEquity);
    GlobalVariableSet(GVNameDayYmd(), (double)g_dailyYmd);

    Print("Daily baseline set (reconstructed @00:00, GMT+", InpDailyResetGmtOffsetHours, "). ymd=", g_dailyYmd,
          " startBalance=", DoubleToString(g_dayStartBalance,2));
  } else {
    if(g_dayStartBalance<=0 && GlobalVariableCheck(GVNameDayStartBal()))
      g_dayStartBalance = GlobalVariableGet(GVNameDayStartBal());
    if(g_dayStartEquity<=0 && GlobalVariableCheck(GVNameDayStartEq()))
      g_dayStartEquity = GlobalVariableGet(GVNameDayStartEq());

    if(g_dayStartBalance<=0) {
      g_dayStartBalance = CalcStartBalanceToday();
      g_dayStartEquity  = g_dayStartBalance;
      GlobalVariableSet(GVNameDayStartBal(), g_dayStartBalance);
      GlobalVariableSet(GVNameDayStartEq(),  g_dayStartEquity);
    }
  }
}

double DailyDdPctBalance()
{
  if(g_dayStartBalance <= 0.0) return 0.0;
  double bal = AccountInfoDouble(ACCOUNT_BALANCE);
  double dd = g_dayStartBalance - bal;
  double pct = (dd / g_dayStartBalance) * 100.0;
  if(pct < 0.0) pct = 0.0;
  return pct;
}

double DailyDdPctEquity()
{
  double denom = (g_dayStartBalance > 0.0 ? g_dayStartBalance : (g_dayStartEquity > 0.0 ? g_dayStartEquity : 0.0));
  if(denom <= 0.0) return 0.0;
  double eq = AccountInfoDouble(ACCOUNT_EQUITY);
  double dd = denom - eq;
  double pct = (dd / denom) * 100.0;
  if(pct < 0.0) pct = 0.0;
  return pct;
}

double PnlTodayUsd()
{
  double startBal = g_dayStartBalance;
  if(startBal <= 0.0) return 0.0;
  double eq = AccountInfoDouble(ACCOUNT_EQUITY);
  return (eq - startBal);
}

double PnlOpenUsd()
{
  double eq = AccountInfoDouble(ACCOUNT_EQUITY);
  double bal = AccountInfoDouble(ACCOUNT_BALANCE);
  return (eq - bal);
}

bool ClosePositionsForThisEA() {
  bool allOk = true;
  for(int i=PositionsTotal()-1; i>=0; i--) {
    ulong ticket = PositionGetTicket(i);
    if(ticket==0) continue;
    if(!PositionSelectByTicket(ticket)) continue;
    string psym = PositionGetString(POSITION_SYMBOL);
    if(psym != InpSymbol) continue;
    long mg = (long)PositionGetInteger(POSITION_MAGIC);
    if((ulong)mg != InpMagic) continue;
    bool ok = trade.PositionClose(ticket);
    if(!ok) ok = trade.PositionClose(psym);
    if(!ok) {
      allOk = false;
      Print("DailyLoss: failed closing position. ticket=", ticket, " ret=", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription());
    } else {
      Print("DailyLoss: closed position. ticket=", ticket);
    }
  }
  return allOk;
}

void EnforceDailyLossGuard() {
  if(InpMaxDailyLossPercent <= 0) return;
  LoadOrResetDayStartEquity();

  double ddBal = DailyDdPctBalance();
  double ddEq  = DailyDdPctEquity();
  double pnlT  = PnlTodayUsd();
  double pnlO  = PnlOpenUsd();

  if(InpEnableBanner) {
    string l1 = "FLEXBOT EA";
    string l2 = g_dailyStop ? "Status: DAILY STOP (limit hit)" : "Status: Waiting for signals...";
    string l3 = "DD Eq: " + DoubleToString(ddEq, 2) + "% / " + DoubleToString(InpMaxDailyLossPercent, 2) + "% | PnL T: " + DoubleToString(pnlT, 2) + "$ | Open: " + DoubleToString(pnlO, 2) + "$";
    SetBanner(l1, l2, l3);
  }

  if(!g_dailyStop && ddEq >= InpMaxDailyLossPercent) {
    g_dailyStop = true;
    Print("DailyLoss HIT (equity): ddEq=", DoubleToString(ddEq,2), "% limit=", DoubleToString(InpMaxDailyLossPercent,2),
          " ddBal=", DoubleToString(ddBal,2), "%");
    if(InpDailyLossClosePositions) ClosePositionsForThisEA();
  }
}

void SaveSinceMs() { GlobalVariableSet(GVNameSince(), (double)g_sinceMs); }
void AdvanceSinceMs(const long createdAtMs) {
  if(createdAtMs <= 0) return;
  long nextSince = createdAtMs + 1;
  if(nextSince > g_sinceMs) { g_sinceMs = nextSince; SaveSinceMs(); }
}

string BuildUrl(const string pathAndQuery) {
  string base = Trim(InpBaseUrl);
  if(StringLen(base)>0 && StringGetCharacter(base,StringLen(base)-1)=='/') base = StringSubstr(base,0,StringLen(base)-1);
  if(StringLen(pathAndQuery)>0 && StringGetCharacter(pathAndQuery,0)!='/') return base + "/" + pathAndQuery;
  return base + pathAndQuery;
}

string HttpGetText(const string url, int &httpStatus) {
  httpStatus=0;
  char result[];
  string headers;
  char data[];
  ResetLastError();
  int res = WebRequest("GET", url, headers, 8000, data, result, headers);
  if(res==-1){ Print("WebRequest GET failed err=",GetLastError()," url=",url); return ""; }
  httpStatus=res;
  return CharArrayToString(result);
}

int HttpPostJson(const string url, const string jsonBody, string extraHeaders = "") {
  char post[];
  StringToCharArray(jsonBody, post, 0, -1, CP_UTF8);
  char result[];
  string headers = "Content-Type: application/json\r\n" + extraHeaders;
  ResetLastError();
  int res = WebRequest("POST", url, headers, 8000, post, result, headers);
  if(res==-1) { Print("WebRequest POST failed err=",GetLastError()," url=",url, " body=", jsonBody); return -1; }
  return res;
}

// Reject a signal server-side so EA doesn't keep re-fetching impossible ones.
string g_lastRejectId = "";
ulong  g_lastRejectTick = 0;

void PostRejectSignal(const string signalId, const string reason, const double curPrice, const double sl, const int digits)
{
  if(!InpEnableRejectPost) return;
  if(Trim(InpEaApiKey)=="") return;
  if(Trim(signalId)=="") return;

  // throttle: avoid spamming same reject
  ulong nowTick = GetTickCount();
  if(signalId == g_lastRejectId && (nowTick - g_lastRejectTick) < 15000) return;
  g_lastRejectId = signalId;
  g_lastRejectTick = nowTick;

  string hdr = "X-API-Key: " + InpEaApiKey + "\r\n";
  string body = "{";
  body += "\"signal_id\":\"" + signalId + "\"";
  body += ",\"reason\":\"" + reason + "\"";
  body += ",\"meta\":{";
  body += "\"symbol\":\"" + InpSymbol + "\"";
  body += ",\"price\":" + DoubleToString(curPrice, digits);
  body += ",\"sl\":" + DoubleToString(sl, digits);
  body += "}}";

  int st = HttpPostJson(BuildUrl("/signal/reject"), body, hdr);
  if(InpDebugHttp) Print("POST /signal/reject code=", st, " id=", signalId, " reason=", reason);
}

void ReportCooldownStateThrottled(const bool active, const long untilMs, const string reason) {
  if(Trim(InpEaApiKey)=="") return;
  long nowMs = NowMsUtc();
  bool changed = (active != g_cdReportedActive) || (active && untilMs != g_cdReportedUntilMs);
  if(!changed && active && (nowMs - g_cdLastPostMs) < 60000) return;
  if(!changed && !active) return;
  string hdr = "X-API-Key: " + InpEaApiKey + "\r\n";
  string body = "{";
  body += "\"symbol\":\"" + InpSymbol + "\"";
  body += ",\"active\":" + string(active ? "true" : "false");
  body += ",\"until\":" + (string)untilMs;
  if(reason!="") body += ",\"reason\":\"" + reason + "\"";
  body += "}";
  int st = HttpPostJson(BuildUrl("/ea/cooldown"), body, hdr);
  if(InpDebugHttp) Print("POST /ea/cooldown code=", st);
  g_cdReportedActive = active;
  g_cdReportedUntilMs = untilMs;
  g_cdLastPostMs = nowMs;
}

// -------- minimal JSON helpers (as provided) --------
bool ExtractJsonObjectByKey(const string json, const string key, string &outObj) {
  outObj="";
  string pat="\"" + key + "\":";
  int i=StringFind(json,pat);
  if(i<0) return false;
  i+=StringLen(pat);
  while(i<StringLen(json)) {
    ushort c=StringGetCharacter(json,i);
    if(c!=' ' && c!='\n' && c!='\r' && c!='\t') break;
    i++;
  }
  if(StringSubstr(json,i,4)=="null") return false;
  if(i>=StringLen(json) || StringGetCharacter(json,i)!='{') return false;
  int start=i, depth=0;
  bool inStr=false, esc=false;
  for(; i<StringLen(json); i++) {
    ushort c=StringGetCharacter(json,i);
    if(inStr) {
      if(esc){ esc=false; continue; }
      if(c=='\\'){ esc=true; continue; }
      if(c=='\"') inStr=false;
      continue;
    }
    if(c=='\"'){ inStr=true; continue; }
    if(c=='{') depth++;
    if(c=='}') {
      depth--;
      if(depth==0){ outObj=StringSubstr(json,start,(i-start)+1); return true; }
    }
  }
  return false;
}

bool JsonGetStringSimple(const string json, const string key, string &out) {
  out="";
  string pat="\"" + key + "\":\"";
  int i=StringFind(json,pat);
  if(i<0) return false;
  i+=StringLen(pat);
  int j=StringFind(json,"\"",i);
  if(j<0) return false;
  out=StringSubstr(json,i,j-i);
  return true;
}

bool JsonGetNumberSimple(const string json, const string key, double &out) {
  out=0.0;
  string pat="\"" + key + "\":";
  int i=StringFind(json,pat);
  if(i<0) return false;
  i+=StringLen(pat);
  while(i<StringLen(json)) {
    ushort c=StringGetCharacter(json,i);
    if(c!=' ' && c!='\n' && c!='\r' && c!='\t') break;
    i++;
  }
  int start=i;
  for(; i<StringLen(json); i++) {
    ushort c=StringGetCharacter(json,i);
    if((c>='0' && c<='9') || c=='-' || c=='+' || c=='.') continue;
    break;
  }
  string num=Trim(StringSubstr(json,start,i-start));
  if(num=="" || num=="null") return false;
  out=StringToDouble(num);
  return true;
}

int StepDigitsFromStep(const double step) {
  if(step >= 1.0) return 0;
  if(step <= 0.0) return 2;
  int d = (int)MathRound(-MathLog10(step));
  if(d < 0) d = 2;
  if(d > 8) d = 8;
  return d;
}

double ClampLots(const string symbol, double lots) {
  double minLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
  double maxLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
  double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
  if(step <= 0.0) step = 0.01;
  lots = MathMax(minLot, MathMin(maxLot, lots));
  double steps = MathFloor(lots/step + 1e-9);
  double v = steps * step;
  return NormalizeDouble(v, StepDigitsFromStep(step));
}

// Risk-based lots: returns lots so that SL hit ~= riskPercent of BALANCE.
double CalcRiskLots(const string symbol, ENUM_ORDER_TYPE ot, double slPrice, double riskPercent)
{
  if(riskPercent <= 0.0) return 0.0;

  double balance = AccountInfoDouble(ACCOUNT_BALANCE);
  if(balance <= 0.0) return 0.0;

  double riskMoney = balance * (riskPercent / 100.0);

  double price = (ot==ORDER_TYPE_BUY) ? SymbolInfoDouble(symbol, SYMBOL_ASK) : SymbolInfoDouble(symbol, SYMBOL_BID);

  double tickSize  = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
  double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
  if(tickSize <= 0.0 || tickValue <= 0.0) return 0.0;

  double slDist = MathAbs(price - slPrice);
  if(slDist <= 0.0) return 0.0;

  double lossPerLot = (slDist / tickSize) * tickValue;
  if(lossPerLot <= 0.0) return 0.0;

  double lots = riskMoney / lossPerLot;
  return ClampLots(symbol, lots);
}

bool HasOpenPositionForMagic(const string sym, const ulong magic, string &ticketOut) {
  ticketOut = "";
  for(int i=PositionsTotal()-1; i>=0; i--) {
    ulong ticket = PositionGetTicket(i);
    if(ticket==0) continue;
    if(!PositionSelectByTicket(ticket)) continue;
    string psym = PositionGetString(POSITION_SYMBOL);
    if(psym != sym) continue;
    long mg = (long)PositionGetInteger(POSITION_MAGIC);
    if((ulong)mg != magic) continue;
    ticketOut = (string)ticket;
    return true;
  }
  return false;
}

ulong g_lastPosReportMs = 0;
long g_lastOkStatusLogMs = 0;
long g_lastOkNextLogMs = 0;

bool ShouldLogOk(long &lastMs, const long intervalMs) {
  long now = NowMsUtc();
  if(lastMs!=0 && (now - lastMs) < intervalMs) return false;
  lastMs = now;
  return true;
}

void ReportPositionStateThrottled() {
  long nowMs = NowMsUtc();
  if(g_lastPosReportMs!=0 && (ulong)(nowMs - (long)g_lastPosReportMs) < (ulong)InpStatusPostSeconds*1000) return;
  g_lastPosReportMs = (ulong)nowMs;
  string ticket;
  bool hasPos = HasOpenPositionForMagic(InpSymbol, InpMagic, ticket);
  string ticketsJson = (ticket != "" ? "[\"" + ticket + "\"]" : "[]");
  long login = AccountInfoInteger(ACCOUNT_LOGIN);
  string server = AccountInfoString(ACCOUNT_SERVER);
  double equity = AccountInfoDouble(ACCOUNT_EQUITY);
  double balance = AccountInfoDouble(ACCOUNT_BALANCE);
  string url = BuildUrl("/ea/status");
  string body = StringFormat(
    "{\"account_login\":%I64d,\"server\":\"%s\",\"magic\":%I64d,\"symbol\":\"%s\",\"has_position\":%s,\"tickets\":%s,\"equity\":%.2f,\"balance\":%.2f,\"time\":%I64d}",
    login, server, (long)InpMagic, InpSymbol, (hasPos ? "true" : "false"), ticketsJson, equity, balance, nowMs
  );
  string hdr = "";
  if(StringLen(Trim(InpEaApiKey)) > 0) hdr = "X-API-Key: " + InpEaApiKey + "\r\n";
  int code = HttpPostJson(url, body, hdr);
  if(InpDebugHttp) {
    if(code < 200 || code >= 300) Print("POST /ea/status code=", code);
    else if(ShouldLogOk(g_lastOkStatusLogMs, 5*60*1000)) Print("POST /ea/status ok");
  }
}

bool CooldownActive() {
  if(InpCooldownMinutes <= 0) return false;
  if(g_lastOpenMs <= 0) return false;
  long cdMs = (long)InpCooldownMinutes * 60 * 1000;
  return (NowMsUtc() - g_lastOpenMs) < cdMs;
}

bool SpreadOk(const string sym) {
  if(MaxSpreadPoints <= 0) return true;
  long spr = (long)SymbolInfoInteger(sym, SYMBOL_SPREAD);
  if(spr <= 0) return true;
  if(spr > MaxSpreadPoints) { Print("Skip: spread too high. spreadPts=", spr); return false; }
  return true;
}

bool EntryDistanceOk(const string sym, double expectedPrice, double fillPrice) {
  if(MaxEntryDistancePoints <= 0) return true;
  double pt = SymbolInfoDouble(sym, SYMBOL_POINT);
  if(pt <= 0.0) return true;
  double distPts = MathAbs(fillPrice - expectedPrice) / pt;
  if(distPts > (double)MaxEntryDistancePoints) { Print("Bad fill distance. distPts=", distPts); return false; }
  return true;
}

bool ClampStopsToBroker(const string sym, const ENUM_ORDER_TYPE ot, const double entry, double &sl, double &tp) {
  MqlTick tk;
  if(!SymbolInfoTick(sym, tk)) return false;

  double pt = SymbolInfoDouble(sym, SYMBOL_POINT);
  if(pt <= 0.0) pt = 0.01;

  long stopsLvl = (long)SymbolInfoInteger(sym, SYMBOL_TRADE_STOPS_LEVEL);
  long freezeLvl = (long)SymbolInfoInteger(sym, SYMBOL_TRADE_FREEZE_LEVEL);

  long bufPts = 5;
  long minPts = (long)MathMax((double)stopsLvl, (double)freezeLvl) + bufPts;
  double minDist = (double)minPts * pt;

  double bid = tk.bid;
  double ask = tk.ask;

  if(ot == ORDER_TYPE_BUY) {
    double slMax = MathMin(bid - minDist, entry - pt);
    double tpMin = MathMax(ask + minDist, entry + pt);

    if(sl >= slMax) sl = slMax;
    if(tp <= tpMin) tp = tpMin;

    if(!(sl < entry && sl < bid && tp > entry && tp > ask)) return false;
  } else if(ot == ORDER_TYPE_SELL) {
    double slMin = MathMax(ask + minDist, entry + pt);
    double tpMax = MathMin(bid - minDist, entry - pt);

    if(sl <= slMin) sl = slMin;
    if(tp >= tpMax) tp = tpMax;

    if(!(sl > entry && sl > ask && tp < entry && tp < bid)) return false;
  } else {
    return false;
  }

  return true;
}

bool ModifyStopsWithRetries(const string sym, ulong ticket, double sl, double tp) {
  bool ok=false;
  for(int attempt=1; attempt<=3; attempt++) {
    ok = trade.PositionModify(ticket, sl, tp);
    if(ok) return true;
    if(PositionSelectByTicket(ticket)) {
      string psym = PositionGetString(POSITION_SYMBOL);
      ok = trade.PositionModify(psym, sl, tp);
      if(ok) return true;
    }
    Print("PositionModify failed attempt ", attempt, ": ", trade.ResultRetcodeDescription());
    Sleep(250);
  }
  return false;
}

// --- Trade execution (single position) ---
bool ExecuteSignal(const string json) {
  string sig;
  if(!ExtractJsonObjectByKey(json,"signal",sig)) return false;

  string id="", sym="", dir="", comment="";
  double sl=0; double createdAt=0; double sigRiskPct=0; double sigTp=0;

  if(!JsonGetStringSimple(sig,"id",id)) return false;
  if(!JsonGetStringSimple(sig,"symbol",sym)) sym=InpSymbol;
  if(!JsonGetStringSimple(sig,"direction",dir)) dir="";
  JsonGetStringSimple(sig,"comment",comment);
  JsonGetNumberSimple(sig,"sl",sl);
  JsonGetNumberSimple(sig,"created_at_ms",createdAt);
  JsonGetNumberSimple(sig,"risk_pct",sigRiskPct);

  // Read first TP from array if present
  int tpKey = StringFind(sig, "\"tp\":[");
  if(tpKey >= 0) {
    int i = tpKey + StringLen("\"tp\":[");
    while(i < StringLen(sig)) {
      ushort c = StringGetCharacter(sig, i);
      if(c!=' ' && c!='\n' && c!='\r' && c!='\t') break;
      i++;
    }
    int start=i;
    while(i < StringLen(sig)) {
      ushort c = StringGetCharacter(sig, i);
      if((c>='0' && c<='9') || c=='-' || c=='+' || c=='.') { i++; continue; }
      break;
    }
    string num = Trim(StringSubstr(sig, start, i-start));
    if(num!="" && num!="null") sigTp = StringToDouble(num);
  }

  long createdAtMs = (long)createdAt;

  if(id=="" ) return false;
  if(id==g_lastSignalId) return false;

  ulong nowTick = GetTickCount();
  if(id==g_lastAttemptId && (nowTick - g_lastAttemptTick) < 15000) return false;
  g_lastAttemptId = id;
  g_lastAttemptTick = nowTick;

  if(dir!="BUY" && dir!="SELL") { return false; }

  if(!SymbolSelect(sym,true)) { return false; }

  EnforceDailyLossGuard();
  if(g_dailyStop) { return false; }

  {
    string openTicket;
    if(HasOpenPositionForMagic(sym, InpMagic, openTicket)) {
      ReportPositionStateThrottled();
      return false;
    }
  }

  if(!SpreadOk(sym)) { return false; }

  if(CooldownActive()) {
    long cdMs = (long)InpCooldownMinutes * 60 * 1000;
    long untilMs = g_lastOpenMs + cdMs;
    ReportCooldownStateThrottled(true, untilMs, "cooldown");
    g_lastSignalId=id;
    return false;
  }

  int digits=(int)SymbolInfoInteger(sym,SYMBOL_DIGITS);
  sl = NormalizeDouble(sl, digits);

  ENUM_ORDER_TYPE ot = (dir=="BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL);

  double curPrice = (ot==ORDER_TYPE_BUY) ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);
  if(ot==ORDER_TYPE_BUY && sl >= curPrice) {
    if(InpDebugTrade) Print("SKIP invalid SL for BUY. id=", id, " price=", DoubleToString(curPrice,digits), " sl=", DoubleToString(sl,digits));
    PostRejectSignal(id, "invalid_sl_buy", curPrice, sl, digits);
    g_lastSignalId = id;
    return false;
  }
  if(ot==ORDER_TYPE_SELL && sl <= curPrice) {
    if(InpDebugTrade) Print("SKIP invalid SL for SELL. id=", id, " price=", DoubleToString(curPrice,digits), " sl=", DoubleToString(sl,digits));
    PostRejectSignal(id, "invalid_sl_sell", curPrice, sl, digits);
    g_lastSignalId = id;
    return false;
  }

  double riskPct = InpMaxRiskPercent;
  if(riskPct <= 0.0) riskPct = 1.0;

  double allowedLots = CalcRiskLots(sym, ot, sl, riskPct);
  if(allowedLots <= 0.0) { return false; }

  if(InpDebugTrade)
  {
    double balance = AccountInfoDouble(ACCOUNT_BALANCE);
    double riskMoney = balance * (riskPct / 100.0);
    double price = (ot==ORDER_TYPE_BUY) ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);
    double tickSize  = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_SIZE);
    double tickValue = SymbolInfoDouble(sym, SYMBOL_TRADE_TICK_VALUE);
    double slDist = MathAbs(price - sl);
    double lossPerLot = (tickSize>0 && tickValue>0) ? (slDist / tickSize) * tickValue : 0.0;

    Print("RiskLots debug | id=", id,
          " bal=", DoubleToString(balance,2),
          " risk%=", DoubleToString(riskPct,2),
          " risk$=", DoubleToString(riskMoney,2),
          " price=", DoubleToString(price,digits),
          " sl=", DoubleToString(sl,digits),
          " slDist=", DoubleToString(slDist,digits),
          " tickSize=", DoubleToString(tickSize,6),
          " tickVal=", DoubleToString(tickValue,2),
          " lossPerLot=", DoubleToString(lossPerLot,2),
          " allowedLots=", DoubleToString(allowedLots,2));
  }

  double lotsTotal = 0.0;
  if(InpUseFixedLot)
  {
    double fixedLots2 = ClampLots(sym, InpFixedLot);
    if(InpMaxLot > 0.0) fixedLots2 = MathMin(fixedLots2, InpMaxLot);
    fixedLots2 = ClampLots(sym, fixedLots2);

    if(fixedLots2 > allowedLots + 1e-9)
    {
      if(InpDebugTrade)
        Print("Skip signal (risk too high for fixed lot). id=", id,
              " fixed=", DoubleToString(fixedLots2,2),
              " allowed=", DoubleToString(allowedLots,2),
              " maxRisk%=", DoubleToString(riskPct,2));
      return false;
    }

    lotsTotal = fixedLots2;
  }
  else
  {
    lotsTotal = allowedLots;
    if(InpMaxLot > 0.0) lotsTotal = MathMin(lotsTotal, InpMaxLot);
    lotsTotal = ClampLots(sym, lotsTotal);
  }

  if(lotsTotal <= 0.0) { return false; }

  double expected = (ot==ORDER_TYPE_BUY) ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);

  trade.SetExpertMagicNumber(InpMagic);
  trade.SetDeviationInPoints(MaxSlippagePoints > 0 ? MaxSlippagePoints : 30);

  bool okOpen = (ot==ORDER_TYPE_BUY) ? trade.Buy(lotsTotal, sym, 0.0, 0.0, 0.0, comment) : trade.Sell(lotsTotal, sym, 0.0, 0.0, 0.0, comment);
  if(!okOpen) { return false; }

  // NOTE: ResultOrder() is ORDER ticket (not position ticket)
  ulong orderTicket = (ulong)trade.ResultOrder();
  g_lastOpenMs = NowMsUtc();
  g_breakEvenDone = false; // reset for new trade

  if(InpCooldownMinutes > 0) {
    long untilMs = g_lastOpenMs + (long)InpCooldownMinutes * 60 * 1000;
    ReportCooldownStateThrottled(true, untilMs, "trade_open");
  }

  ReportPositionStateThrottled();

  // Find the actual position and use that ticket for everything (modify/close)
  ulong posTicket = 0;
  if(!WaitForMyPosition(sym, InpMagic, posTicket, 12, 150))
  {
    Print("ERROR: opened order but position not found (timing). orderTicket=", orderTicket);
    return false;
  }

  if(!PositionSelectByTicket(posTicket)) return false;

  double entry = PositionGetDouble(POSITION_PRICE_OPEN);
  if(!EntryDistanceOk(sym, expected, entry)) {
    trade.PositionClose(posTicket);
    return false;
  }

  double risk = MathAbs(entry - sl);
  if(risk <= 0.0) { return false; }

  double tp = sigTp;
  if(tp <= 0 || (ot==ORDER_TYPE_BUY && tp <= entry) || (ot==ORDER_TYPE_SELL && tp >= entry))
    tp = (ot == ORDER_TYPE_BUY) ? (entry + (RR * risk)) : (entry - (RR * risk));

  if(!ClampStopsToBroker(sym, ot, entry, sl, tp)) {
    if(InpDebugTrade) Print("SKIP/FAIL: could not clamp stops to broker rules. id=", id, " entry=", DoubleToString(entry,digits), " sl=", DoubleToString(sl,digits), " tp=", DoubleToString(tp,digits));
    trade.PositionClose(posTicket);
    g_lastOpenMs = 0;
    return false;
  }

  sl = NormalizeDouble(sl, digits);
  tp = NormalizeDouble(tp, digits);

  bool okMod = ModifyStopsWithRetries(sym, posTicket, sl, tp);
  if(InpDebugTrade) Print("Stops set okMod=", (okMod?"true":"false"), " entry=", DoubleToString(entry,digits), " sl=", DoubleToString(sl,digits), " tp=", DoubleToString(tp,digits), " posTicket=", (string)posTicket, " orderTicket=", (string)orderTicket);

  if(!okMod) {
    if(InpDebugTrade) Print("SKIP/FAIL: could not set stops. Closing position. id=", id, " posTicket=", (string)posTicket);
    trade.PositionClose(posTicket);
    g_lastOpenMs = 0;

    ReportPositionStateThrottled();

    if(InpEnableExecPost) {
      long nowMs = NowMsUtc();
      string body = "{";
      body += "\"signal_id\":\"" + id + "\"";
      body += ",\"ticket\":\"" + (string)posTicket + "\"";
      body += ",\"order_ticket\":\"" + (string)orderTicket + "\"";
      body += ",\"fill_price\":" + DoubleToString(entry, digits);
      body += ",\"direction\":\"" + dir + "\"";
      body += ",\"account_login\":" + (string)AccountInfoInteger(ACCOUNT_LOGIN);
      body += ",\"server\":\"" + AccountInfoString(ACCOUNT_SERVER) + "\"";
      body += ",\"ok_mod\":false";
      body += ",\"time\":" + (string)nowMs;
      body += "}";
      int st = HttpPostJson(BuildUrl("/signal/executed"), body);
      if(InpDebugHttp) Print("POST /signal/executed (ok_mod=false) code=", st);
    }

    return false;
  }

  // Map signal id -> position identifier (stable for close callbacks)
  ulong posIdMap = 0;
  if(PositionSelectByTicket(posTicket)) {
    posIdMap = (ulong)PositionGetInteger(POSITION_IDENTIFIER);
  }
  if(posIdMap != 0) {
    PosMapSet(posIdMap, id);
  }

  g_lastSignalId = id;
  PersistSaveSignalId(id);
  AdvanceSinceMs(createdAtMs);

  if(InpEnableExecPost) {
    long nowMs = NowMsUtc();
    string body = "{";
    body += "\"signal_id\":\"" + id + "\"";
    body += ",\"ticket\":\"" + (string)posTicket + "\"";
    body += ",\"order_ticket\":\"" + (string)orderTicket + "\"";
    body += ",\"fill_price\":" + DoubleToString(entry, digits);
    body += ",\"direction\":\"" + dir + "\"";
    body += ",\"account_login\":" + (string)AccountInfoInteger(ACCOUNT_LOGIN);
    body += ",\"server\":\"" + AccountInfoString(ACCOUNT_SERVER) + "\"";
    body += ",\"ok_mod\":true";
    body += ",\"time\":" + (string)nowMs;
    body += "}";
    int st = HttpPostJson(BuildUrl("/signal/executed"), body);
    if(InpDebugHttp) Print("POST /signal/executed (ok_mod=true) code=", st);
  }

  return true;
}

// ===== Trade Management: Break-Even + Trailing Stop =====
void ManageOpenPosition()
{
   if(!InpEnableBreakEven && !InpEnableTrailing) return;

   ulong posTicket = FindMyPositionTicket(InpSymbol, InpMagic);
   if(posTicket == 0) {
      g_breakEvenDone = false; // reset for next trade
      return;
   }

   if(!PositionSelectByTicket(posTicket)) return;

   double entry = PositionGetDouble(POSITION_PRICE_OPEN);
   double sl    = PositionGetDouble(POSITION_SL);
   double tp    = PositionGetDouble(POSITION_TP);
   long   type  = PositionGetInteger(POSITION_TYPE);

   if(tp <= 0.0 || sl <= 0.0) return; // no SL/TP set

   double pt = SymbolInfoDouble(InpSymbol, SYMBOL_POINT);
   if(pt <= 0.0) pt = 0.01;
   int digits = (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS);

   double bid = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
   double curPrice = (type == POSITION_TYPE_BUY) ? bid : ask;

   double tpDist    = MathAbs(tp - entry);
   double profitDist = 0.0;

   if(type == POSITION_TYPE_BUY)
      profitDist = curPrice - entry;
   else
      profitDist = entry - curPrice;

   if(tpDist <= 0.0) return;

   double profitPct = (profitDist / tpDist) * 100.0;

   // --- Break-Even ---
   if(InpEnableBreakEven && !g_breakEvenDone && profitPct >= InpBreakEvenPct)
   {
      double newSl;
      if(type == POSITION_TYPE_BUY)
         newSl = entry + InpBreakEvenBuffer;
      else
         newSl = entry - InpBreakEvenBuffer;

      newSl = NormalizeDouble(newSl, digits);

      // Only move if new SL is better than current SL
      bool better = (type == POSITION_TYPE_BUY) ? (newSl > sl) : (newSl < sl);
      if(better)
      {
         bool ok = trade.PositionModify(posTicket, newSl, tp);
         if(ok) {
            g_breakEvenDone = true;
            if(InpDebugTrade) Print("BREAK-EVEN: moved SL to ", DoubleToString(newSl, digits), " (entry+buffer)");
         }
      }
      else {
         g_breakEvenDone = true; // SL already past entry
      }
   }

   // --- Trailing Stop ---
   if(InpEnableTrailing && profitPct >= InpTrailStartPct)
   {
      double trailDist;
      if(InpTrailDistPoints > 0) {
         trailDist = InpTrailDistPoints * pt;  // fixed points mode
      } else {
         // R-based mode: trail distance = SL distance * InpTrailDistR
         double slDist = MathAbs(entry - PositionGetDouble(POSITION_SL));
         // Use original SL distance (before BE moved it): approximate from TP distance / RR
         if(slDist < pt * 10 && tpDist > 0) slDist = tpDist / RR;  // fallback if SL was already moved to BE
         trailDist = slDist * InpTrailDistR;
      }

      double newSl;

      if(type == POSITION_TYPE_BUY)
         newSl = curPrice - trailDist;
      else
         newSl = curPrice + trailDist;

      newSl = NormalizeDouble(newSl, digits);

      // Only move SL if it's better (higher for BUY, lower for SELL)
      bool better = (type == POSITION_TYPE_BUY) ? (newSl > sl + pt) : (newSl < sl - pt);
      if(better)
      {
         bool ok = trade.PositionModify(posTicket, newSl, tp);
         if(ok && InpDebugTrade)
            Print("TRAILING: moved SL to ", DoubleToString(newSl, digits),
                  " price=", DoubleToString(curPrice, digits),
                  " trailDist=", DoubleToString(trailDist, digits),
                  " profit%=", DoubleToString(profitPct, 1));
      }
   }
}

// ===== Price Pusher + Seed Functions =====
string EscJson(string s)
{
   StringReplace(s, "\\", "\\\\");
   StringReplace(s, "\"", "\\\"");
   return s;
}

string IsoUtcForSeed(datetime srv)
{
   datetime utc = srv - (TimeCurrent() - TimeGMT());
   string t = TimeToString(utc, TIME_DATE|TIME_SECONDS);
   StringReplace(t, ".", "-");
   StringReplace(t, " ", "T");
   t += ".000Z";
   return t;
}

int HttpPostJsonRaw(const string url, const string body, const int timeoutMs)
{
   int len = StringLen(body);
   uchar data[];
   ArrayResize(data, len);
   StringToCharArray(body, data, 0, len);
   uchar result[];
   string headers = "Content-Type: application/json\r\n";
   string resp_headers;
   ResetLastError();
   int code = WebRequest("POST", url, headers, timeoutMs, data, result, resp_headers);
   if(code < 200 || code >= 300)
      Print("HTTP POST FAIL ", url, " status=", code, " err=", GetLastError());
   return code;
}

void PushPrice()
{
   if(!InpEnablePricePush) return;
   if(!SymbolSelect(InpSymbol, true)) return;

   double bid = SymbolInfoDouble(InpSymbol, SYMBOL_BID);
   double ask = SymbolInfoDouble(InpSymbol, SYMBOL_ASK);
   if(bid <= 0 || ask <= 0) return;

   int digits = (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS);
   datetime utc = TimeGMT();
   long ts_ms = (long)utc * 1000;
   datetime srvNow = TimeCurrent();
   long server_ts = (long)srvNow;
   string t_server = TimeToString(srvNow, TIME_DATE|TIME_SECONDS);
   StringReplace(t_server, ".", "-");
   StringReplace(t_server, " ", "T");

   string body = StringFormat(
      "{\"symbol\":\"%s\",\"bid\":%s,\"ask\":%s,\"time\":\"%s\",\"ts\":%I64d,\"server_ts\":%I64d}",
      EscJson(InpSymbol),
      DoubleToString(bid, digits),
      DoubleToString(ask, digits),
      EscJson(t_server),
      ts_ms,
      server_ts
   );

   int http = HttpPostJsonRaw(BuildUrl("/price"), body, 5000);
   if(http < 200 || http >= 300) Print("PRICE POST failed HTTP=", http);
}

bool TrySeedM15()
{
   SymbolSelect(InpSymbol, true);
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   ResetLastError();
   int copied = CopyRates(InpSymbol, PERIOD_M15, 0, InpSeedTargetM15, rates);
   int e = GetLastError();

   if(copied <= 0) {
      Print("SEED: CopyRates returned 0. err=", e);
      return false;
   }
   if(copied < InpSeedMinBars) {
      Print("SEED: only ", copied, " M15 bars. Need >= ", InpSeedMinBars);
      return false;
   }

   int digits = (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS);
   int bs = InpSeedBatchSize;
   if(bs < 10) bs = 10;
   if(bs > copied) bs = copied;

   Print("SEED: sending ", copied, " M15 bars, batchSize=", bs);

   string seedUrl = BuildUrl("/seed");

   for(int batchStart = copied - 1; batchStart >= 0; batchStart -= bs)
   {
      int batchEnd = batchStart - (bs - 1);
      if(batchEnd < 0) batchEnd = 0;

      string candles = "[";
      bool first = true;

      for(int i = batchStart; i >= batchEnd; i--)
      {
         datetime barServer = rates[i].time;
         datetime endServer = barServer + 15 * 60;

         string startIso = IsoUtcForSeed(barServer);
         string endIso   = IsoUtcForSeed(endServer);

         string o = DoubleToString(rates[i].open,  digits);
         string h = DoubleToString(rates[i].high,  digits);
         string l = DoubleToString(rates[i].low,   digits);
         string c = DoubleToString(rates[i].close, digits);

         string item = StringFormat(
            "{\"start\":\"%s\",\"end\":\"%s\",\"open\":%s,\"high\":%s,\"low\":%s,\"close\":%s}",
            EscJson(startIso), EscJson(endIso), o, h, l, c
         );

         if(!first) candles += ",";
         candles += item;
         first = false;
      }
      candles += "]";

      string body = StringFormat(
         "{\"symbol\":\"%s\",\"interval\":\"15m\",\"candles\":%s}",
         EscJson(InpSymbol), candles
      );

      int http = HttpPostJsonRaw(seedUrl, body, InpSeedTimeoutMs);
      if(http < 200 || http >= 300) {
         Print("SEED: batch failed HTTP=", http);
         return false;
      }
      Sleep(150);
   }

   Print("SEED: OK ✅");
   return true;
}

string GVManualSig(const ulong posTicket){ return "FLEXBOT_MANUAL_SIG_" + (string)posTicket; }

void OnTradeTransaction(const MqlTradeTransaction& trans, const MqlTradeRequest& request, const MqlTradeResult& result)
{
  if(!InpEnableClosePost) { if(InpDebugTrade) Print("ClosePost skip: disabled"); return; }
  if(Trim(InpSignalSecret)=="") { if(InpDebugTrade) Print("ClosePost skip: InpSignalSecret empty"); return; }

  if(g_lastSignalId=="") {
    PersistLoad();
    if(Trim(g_persistedSignalId)!="") g_lastSignalId = g_persistedSignalId;
  }

  if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
  ulong deal = trans.deal;
  if(deal == 0) return;
  if(!HistoryDealSelect(deal)) return;

  string sym = HistoryDealGetString(deal, DEAL_SYMBOL);
  if(sym != InpSymbol) { if(InpDebugTrade) Print("ClosePost skip: symbol mismatch dealSym=", sym); return; }

  long magic = (long)HistoryDealGetInteger(deal, DEAL_MAGIC);
  if((ulong)magic != InpMagic && magic != 0) { if(InpDebugTrade) Print("ClosePost skip: magic mismatch dealMagic=", magic); return; }

  long entryType = HistoryDealGetInteger(deal, DEAL_ENTRY);

  if(entryType == DEAL_ENTRY_IN) {
    if(Trim(InpEaApiKey)=="" || Trim(InpBaseUrl)=="") return;

    long magicOpen = (long)HistoryDealGetInteger(deal, DEAL_MAGIC);
    if(magicOpen != 0) return;

    ulong posTicket = (ulong)HistoryDealGetInteger(deal, DEAL_POSITION_ID);
    if(posTicket == 0) return;

    string gv = GVManualSig(posTicket);
    if(GlobalVariableCheck(gv)) return;

    double slP=0.0, tpP=0.0, fillP=0.0;
    bool found=false;
    for(int i=PositionsTotal()-1; i>=0; i--) {
      ulong t = PositionGetTicket(i);
      if(t==0) continue;
      if(!PositionSelectByTicket(t)) continue;
      if((ulong)PositionGetInteger(POSITION_TICKET) != posTicket) continue;
      if(PositionGetString(POSITION_SYMBOL) != InpSymbol) continue;
      slP = PositionGetDouble(POSITION_SL);
      tpP = PositionGetDouble(POSITION_TP);
      fillP = PositionGetDouble(POSITION_PRICE_OPEN);
      found=true;
      break;
    }
    if(!found) return;
    if(slP<=0.0 || tpP<=0.0) return;

    long dealType2 = HistoryDealGetInteger(deal, DEAL_TYPE);
    string dir2 = (dealType2 == DEAL_TYPE_BUY ? "BUY" : (dealType2 == DEAL_TYPE_SELL ? "SELL" : ""));
    if(dir2=="") return;

    long login = AccountInfoInteger(ACCOUNT_LOGIN);
    string manualId = "m-" + (string)login + "-" + (string)posTicket;

    string hdr = "X-API-Key: " + InpEaApiKey + "\r\n";
    long nowMs = NowMsUtc();

    string body2 = "{";
    body2 += "\"id\":\"" + manualId + "\"";
    body2 += ",\"symbol\":\"" + InpSymbol + "\"";
    body2 += ",\"direction\":\"" + dir2 + "\"";
    body2 += ",\"sl\":" + DoubleToString(slP, (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS));
    body2 += ",\"tp\":[" + DoubleToString(tpP, (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS)) + "]";
    body2 += ",\"ticket\":\"" + (string)posTicket + "\"";
    body2 += ",\"fill_price\":" + DoubleToString(fillP, (int)SymbolInfoInteger(InpSymbol, SYMBOL_DIGITS));
    body2 += ",\"risk_pct\":" + DoubleToString(InpRiskPercent, 2);
    body2 += ",\"comment\":\"manual\"";
    body2 += ",\"account_login\":" + (string)AccountInfoInteger(ACCOUNT_LOGIN);
    body2 += ",\"server\":\"" + AccountInfoString(ACCOUNT_SERVER) + "\"";
    body2 += ",\"time\":" + (string)nowMs;
    body2 += "}";

    int st2 = HttpPostJson(BuildUrl("/signal/manual/open"), body2, hdr);
    if(InpDebugHttp) Print("POST /signal/manual/open code=", st2, " id=", manualId);
    if(st2 >= 200 && st2 < 300) {
      GlobalVariableSet(gv, 1.0);
    }
    return;
  }

  if(entryType != DEAL_ENTRY_OUT) { return; }

  ulong posIdClose = (ulong)HistoryDealGetInteger(deal, DEAL_POSITION_ID);
  string sigId2 = "";

  string gv2 = GVManualSig(posIdClose);
  if(posIdClose != 0 && GlobalVariableCheck(gv2)) {
    long login2 = AccountInfoInteger(ACCOUNT_LOGIN);
    sigId2 = "m-" + (string)login2 + "-" + (string)posIdClose;
  } else {
    string mapped = "";
    if(PosMapGet(posIdClose, mapped)) sigId2 = mapped;
  }

  if(Trim(sigId2)=="") {
    if(InpDebugTrade) Print("ClosePost skip: no signal mapping for posId=", (string)posIdClose, " (prevents wrong BUY/SELL cards)");
    return;
  }

  if(g_lastClosedSignalId == sigId2) { if(InpDebugTrade) Print("ClosePost skip: already posted for signal_id=", sigId2); return; }

  long reason = HistoryDealGetInteger(deal, DEAL_REASON);
  string outcome = "CLOSED";
  if(reason == DEAL_REASON_TP) outcome = "TP hit";
  else if(reason == DEAL_REASON_SL) outcome = "SL hit";

  double profit = HistoryDealGetDouble(deal, DEAL_PROFIT);
  double swap   = HistoryDealGetDouble(deal, DEAL_SWAP);
  double comm   = HistoryDealGetDouble(deal, DEAL_COMMISSION);
  double net    = profit + swap + comm;
  string resultStr = DoubleToString(net, 2) + " USD";

  string dealDir = "";
  if(posIdClose != 0) {
    datetime toTs2 = TimeCurrent();
    datetime fromTs2 = toTs2 - 7*24*60*60;
    if(HistorySelect(fromTs2, toTs2)) {
      int total2 = (int)HistoryDealsTotal();
      for(int i=0; i<total2; i++) {
        ulong d2 = HistoryDealGetTicket(i);
        if(d2==0) continue;
        if(!HistoryDealSelect(d2)) continue;
        if((ulong)HistoryDealGetInteger(d2, DEAL_POSITION_ID) != posIdClose) continue;
        long ent2 = HistoryDealGetInteger(d2, DEAL_ENTRY);
        if(ent2 != DEAL_ENTRY_IN) continue;
        long tp2 = HistoryDealGetInteger(d2, DEAL_TYPE);
        if(tp2 == DEAL_TYPE_BUY) { dealDir = "BUY"; break; }
        if(tp2 == DEAL_TYPE_SELL){ dealDir = "SELL"; break; }
      }
    }
  }

  string body = "{";
  body += "\"secret\":\"" + InpSignalSecret + "\"";
  body += ",\"signal_id\":\"" + sigId2 + "\"";
  if(dealDir != "") body += ",\"direction\":\"" + dealDir + "\"";
  body += ",\"outcome\":\"" + outcome + "\"";
  body += ",\"result\":\"" + resultStr + "\"";
  body += ",\"account_login\":" + (string)AccountInfoInteger(ACCOUNT_LOGIN);
  body += ",\"server\":\"" + AccountInfoString(ACCOUNT_SERVER) + "\"";
  body += ",\"closed_at_ms\":" + (string)((long)TimeCurrent()*1000);
  body += "}";

  int st = HttpPostJson(BuildUrl("/signal/closed"), body);
  if(InpDebugHttp) Print("POST /signal/closed code=", st, " outcome=", outcome, " result=", resultStr, " signal_id=", sigId2);
  if(st >= 200 && st < 300) {
    g_lastClosedSignalId = sigId2;
    PersistSaveClosedSignalId(g_lastClosedSignalId);
  }
}

int OnInit() {
  string gv = GVNameSince();
  if(GlobalVariableCheck(gv)) g_sinceMs = (long)GlobalVariableGet(gv);
  else g_sinceMs = NowMsUtc();
  SaveSinceMs();

  g_dailyYmd = (int)(GlobalVariableCheck(GVNameDayYmd()) ? GlobalVariableGet(GVNameDayYmd()) : 0);
  if(GlobalVariableCheck(GVNameDayStartBal())) g_dayStartBalance = GlobalVariableGet(GVNameDayStartBal());
  if(GlobalVariableCheck(GVNameDayStartEq())) g_dayStartEquity = GlobalVariableGet(GVNameDayStartEq());
  LoadOrResetDayStartEquity();

  if(InpEnableBanner) {
    CleanupBannerAllOnChart();
    RemoveBanner();
    EnsureBannerObjects();
  }

  PersistLoad();
  if(Trim(g_persistedSignalId)!="") g_lastSignalId = g_persistedSignalId;
  if(Trim(g_persistedClosedSignalId)!="") g_lastClosedSignalId = g_persistedClosedSignalId;

  Print("flexbot EA initialized. BaseUrl=",InpBaseUrl, " Symbol=",InpSymbol, " since_ms(UTC)=", g_sinceMs, " persistedSignal=", g_lastSignalId);
  EventSetTimer(1);

  if(InpDoSeed)
    g_nextSeedTry = TimeCurrent() + 2;

  return INIT_SUCCEEDED;
}

void OnDeinit(const int reason){ EventKillTimer(); if(InpEnableBanner) RemoveBanner(); }

void OnTick() {
  if(!InpEnablePricePush) return;
  ulong now = GetTickCount();
  if(g_lastPricePushMs != 0 && (now - g_lastPricePushMs) < (ulong)InpPricePushMs) return;
  g_lastPricePushMs = now;
  PushPrice();
  ManageOpenPosition();
}

void OnTimer() {
  // Seed M15 history (once after startup)
  if(InpDoSeed && !g_seedDone && TimeCurrent() >= g_nextSeedTry) {
    g_seedDone = TrySeedM15();
    g_nextSeedTry = TimeCurrent() + InpSeedRetrySec;
  }

  ulong nowMs=(ulong)(GetMicrosecondCount()/1000);
  if(g_lastPollMs!=0 && nowMs-g_lastPollMs < (ulong)InpPollSeconds*1000) return;
  g_lastPollMs=nowMs;

  EnforceDailyLossGuard();
  ReportPositionStateThrottled();

  if(InpCooldownMinutes > 0) {
    if(CooldownActive()) {
      long untilMs = g_lastOpenMs + (long)InpCooldownMinutes * 60 * 1000;
      ReportCooldownStateThrottled(true, untilMs, "cooldown");
    } else {
      ReportCooldownStateThrottled(false, 0, "cooldown_end");
    }
  }

  int st=0;

  // include account_login + server
  long login = AccountInfoInteger(ACCOUNT_LOGIN);
  string srvQ = UrlEncode(AccountInfoString(ACCOUNT_SERVER));

  string url = BuildUrl("/signal/next?symbol=" + InpSymbol +
                        "&since_ms=" + (string)g_sinceMs +
                        "&account_login=" + (string)login +
                        "&server=" + srvQ);

  string body=HttpGetText(url, st);
  if(InpDebugHttp) {
    if(st < 200 || st >= 300) Print("Next status=",st," url=", url);
    else if(ShouldLogOk(g_lastOkNextLogMs, 5*60*1000)) Print("Next ok");
  }

  g_connOk = (st>=200 && st<300);
  if(InpEnableBanner && !g_dailyStop) {
    LoadOrResetDayStartEquity();
    double ddEq = DailyDdPctEquity();
    double pnlT = PnlTodayUsd();
    double pnlO = PnlOpenUsd();
    SetBanner("FLEXBOT EA", "Status: Waiting for signals...",
              "DD Eq: " + DoubleToString(ddEq,2) + "% / " + DoubleToString(InpMaxDailyLossPercent,2) + "% | PnL T: " + DoubleToString(pnlT,2) + "$ | Open: " + DoubleToString(pnlO,2) + "$");
  }

  if(st<200 || st>=300) return;
  ExecuteSignal(body);
}
