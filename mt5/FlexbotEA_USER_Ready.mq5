//+------------------------------------------------------------------+
//| FlexbotEA_USER_Ready.mq5                                        |
//| (Based on FlexbotSignalEA v9)                                    |
//|                                                                  |
//| Purpose: Poll /signal/next and trade once, without log-spam.      |
//|                                                                  |
//| Changes (scaling fix):                                           |
//| - Default to equity-scaling lot size (100k->1.00, 10k->0.10)     |
//| - Keep fixed-lot mode available via InpUseFixedLot                |
//| - Robust lot normalization using SYMBOL_VOLUME_STEP               |
//+------------------------------------------------------------------+
#property strict

#include <Trade/Trade.mqh>
CTrade trade;

// ===== Inputs =====
input string InpBaseUrl = "https://flexbot-qpf2.onrender.com";
input string InpSymbol = "XAUUSD";
input double InpRiskPercent = 1.0; // requested risk % (legacy; used only by CalcRiskLots)
input double MaxRiskPercent = 1.0; // hard cap (legacy)

// Lotsize
input bool InpUseFixedLot = false; // AUTO (recommended): lot size from SL distance so risk <= InpMaxRiskPercent
input double InpFixedLot = 1.0;  // (unused when InpUseFixedLot=false)

// Risk gate: only open trades when risk with InpFixedLot is <= this %
input double InpMaxRiskPercent = 1.0; // max risk per trade (AUTO lots). 100k≈1.0 lot, 10k≈0.10 lot depending on SL.
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

// CLOSE recap posting (disabled in user EA; handled by master account)
input bool InpEnableClosePost = false;

input bool InpDebugHttp = true;
input bool InpDebugTrade = true;

// Safety
input bool InpBlockSameDirection = true;
input int InpCooldownMinutes = 30;

// Prop / FTMO guard
input double InpMaxDailyLossPercent = 4.0;
input bool InpDailyLossClosePositions = true;

// Execution / slippage protection
input int MaxSpreadPoints = 120; // 0 disables
input int MaxSlippagePoints = 30;
input int MaxEntryDistancePoints = 60;

// FTMO / sanity guards
input int MinSLDistancePoints = 300;
input int MinTPDistancePoints = 300;

// ===== Internal =====
ulong g_lastPollMs = 0;
string g_lastSignalId = "";
string g_lastSeenId = "";
long g_sinceMs = 0;
long g_lastOpenMs = 0;

// user-friendly health logs
bool g_loggedInit = false;
bool g_loggedConnected = false;

// Close recap state
datetime g_lastCloseDealTime = 0;
string g_lastClosedSignalId = "";

// Daily loss guard
bool g_dailyStop = false;
int g_dailyYmd = 0;
double g_dayStartEquity = 0.0;

// Cooldown reporting to backend
bool g_cdReportedActive = false;
long g_cdReportedUntilMs = 0;
long g_cdLastPostMs = 0;

// ---------- helpers ----------
string Trim(const string s){ string r=s; StringTrimLeft(r); StringTrimRight(r); return r; }
long NowMsUtc(){ return (long)TimeGMT() * 1000; }
string GVNameSince(){ return "flexbot_since_ms_" + InpSymbol; }
string GVNameDayStartEq(){ return "flexbot_daystart_eq_" + InpSymbol + "_" + (string)InpMagic; }
string GVNameDayYmd(){ return "flexbot_day_ymd_" + InpSymbol + "_" + (string)InpMagic; }

int ServerYmd() {
  MqlDateTime dt;
  TimeToStruct(TimeCurrent(), dt);
  return dt.year*10000 + dt.mon*100 + dt.day;
}

void LoadOrResetDayStartEquity() {
  int ymd = ServerYmd();
  if(ymd != g_dailyYmd) {
    g_dailyYmd = ymd;
    g_dailyStop = false;
    g_dayStartEquity = AccountInfoDouble(ACCOUNT_EQUITY);
    GlobalVariableSet(GVNameDayStartEq(), g_dayStartEquity);
    GlobalVariableSet(GVNameDayYmd(), (double)g_dailyYmd);
    Print("Daily baseline set (server day). ymd=", g_dailyYmd, " startEquity=", DoubleToString(g_dayStartEquity,2));
  } else {
    if(g_dayStartEquity<=0 && GlobalVariableCheck(GVNameDayStartEq()))
      g_dayStartEquity = GlobalVariableGet(GVNameDayStartEq());
  }
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
  if(g_dayStartEquity <= 0) return;
  double eq = AccountInfoDouble(ACCOUNT_EQUITY);
  double dd = g_dayStartEquity - eq;
  double ddPct = (dd / g_dayStartEquity) * 100.0;
  if(!g_dailyStop && ddPct >= InpMaxDailyLossPercent) {
    g_dailyStop = true;
    Print("DailyLoss HIT: ddPct=", DoubleToString(ddPct,2), "% limit=", DoubleToString(InpMaxDailyLossPercent,2));
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
  // floor to step so we don't accidentally oversize
  double steps = MathFloor(lots/step + 1e-9);
  double v = steps * step;
  return NormalizeDouble(v, StepDigitsFromStep(step));
}

// Risk-based lots: returns lots so that SL hit ~= riskPercent of BALANCE.
// This guarantees risk never exceeds riskPercent if SL is actually set.
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
  string url = BuildUrl("/ea/status");
  string body = StringFormat(
    "{\"account_login\":%I64d,\"server\":\"%s\",\"magic\":%I64d,\"symbol\":\"%s\",\"has_position\":%s,\"tickets\":%s,\"equity\":%.2f,\"time\":%I64d}",
    login, server, (long)InpMagic, InpSymbol, (hasPos ? "true" : "false"), ticketsJson, equity, nowMs
  );
  string hdr = "";
  if(StringLen(Trim(InpEaApiKey)) > 0) hdr = "X-API-Key: " + InpEaApiKey + "\r\n";
  int code = HttpPostJson(url, body, hdr);
  if(InpDebugHttp) Print("POST /ea/status code=", code);
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

// --- On-chart banner (always visible) ---
string BannerPrefix(){ return "FLEXBOT_BANNER_" + InpSymbol + "_" + (string)InpMagic; }
string BannerRectName(){ return BannerPrefix() + "_RECT"; }
string BannerLineName(const int i){ return BannerPrefix() + "_LINE" + (string)i; }
string g_bannerLine1 = "";
string g_bannerLine2 = "";
string g_bannerLine3 = "";

int BannerWidthByText(const string l1, const string l2, const string l3) {
  int m = (int)MathMax(StringLen(l1), MathMax(StringLen(l2), StringLen(l3)));
  // rough estimate: ~8 px per char + padding
  int w = 40 + m * 8;
  if(w < 420) w = 420;
  if(w > 860) w = 860;
  return w;
}

void EnsureBannerObjects() {
  long cid = ChartID();

  // rectangle background
  if(ObjectFind(cid, BannerRectName()) < 0) {
    ObjectCreate(cid, BannerRectName(), OBJ_RECTANGLE_LABEL, 0, 0, 0);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_CORNER, CORNER_LEFT_UPPER);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_XDISTANCE, 10);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_YDISTANCE, 18);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_XSIZE, 560);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_YSIZE, 84);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_COLOR, clrNONE);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_BGCOLOR, (color)0x6D28D9); // purple
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_BORDER_TYPE, BORDER_FLAT);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_BACK, false);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_SELECTABLE, false);
    ObjectSetInteger(cid, BannerRectName(), OBJPROP_HIDDEN, true);
  }

  // 3 separate text lines for clean layout
  for(int i=1;i<=3;i++) {
    string n = BannerLineName(i);
    if(ObjectFind(cid, n) < 0) {
      ObjectCreate(cid, n, OBJ_LABEL, 0, 0, 0);
      ObjectSetInteger(cid, n, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(cid, n, OBJPROP_XDISTANCE, 26);
      ObjectSetInteger(cid, n, OBJPROP_COLOR, clrWhite);
      ObjectSetString(cid, n, OBJPROP_FONT, "Segoe UI");
      ObjectSetInteger(cid, n, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(cid, n, OBJPROP_HIDDEN, true);
    }
  }

  // vertical spacing + font sizes
  ObjectSetInteger(cid, BannerLineName(1), OBJPROP_YDISTANCE, 26);
  ObjectSetInteger(cid, BannerLineName(1), OBJPROP_FONTSIZE, 16);

  ObjectSetInteger(cid, BannerLineName(2), OBJPROP_YDISTANCE, 48);
  ObjectSetInteger(cid, BannerLineName(2), OBJPROP_FONTSIZE, 14);

  ObjectSetInteger(cid, BannerLineName(3), OBJPROP_YDISTANCE, 68);
  ObjectSetInteger(cid, BannerLineName(3), OBJPROP_FONTSIZE, 12);
}

void SetBanner(const string l1, const string l2, const string l3) {
  EnsureBannerObjects();
  g_bannerLine1 = l1; g_bannerLine2 = l2; g_bannerLine3 = l3;

  long cid = ChartID();
  int w = BannerWidthByText(l1,l2,l3);
  ObjectSetInteger(cid, BannerRectName(), OBJPROP_XSIZE, w);

  ObjectSetString(cid, BannerLineName(1), OBJPROP_TEXT, l1);
  ObjectSetString(cid, BannerLineName(2), OBJPROP_TEXT, l2);
  ObjectSetString(cid, BannerLineName(3), OBJPROP_TEXT, l3);
  ChartRedraw(cid);
}

void RemoveBanner() {
  long cid = ChartID();
  ObjectDelete(cid, BannerRectName());
  ObjectDelete(cid, BannerLineName(1));
  ObjectDelete(cid, BannerLineName(2));
  ObjectDelete(cid, BannerLineName(3));
}

// --- Trade execution (single position) ---
void LogSkip(const string reason, const string id="") {
  // Keep logs user-friendly and actionable
  if(id!="") Print("SKIP(", id, "): ", reason);
  else Print("SKIP: ", reason);
  SetBanner("FLEXBOT USER EA", "Status: SKIP", reason);
}

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
  AdvanceSinceMs(createdAtMs);

  if(id=="" || id==g_lastSeenId) return false;
  g_lastSeenId = id;
  if(id==g_lastSignalId) return false;

  if(dir!="BUY" && dir!="SELL") { LogSkip("bad direction="+dir, id); g_lastSignalId=id; return false; }

  if(!SymbolSelect(sym,true)) { LogSkip("symbol not available/select failed: "+sym, id); g_lastSignalId=id; return false; }

  EnforceDailyLossGuard();
  if(g_dailyStop) { LogSkip("daily loss stop active", id); g_lastSignalId=id; return false; }

  // Only 1 open trade per magic
  {
    string openTicket;
    if(HasOpenPositionForMagic(sym, InpMagic, openTicket)) {
      LogSkip("already has open position (ticket="+openTicket+")", id);
      g_lastSignalId=id;
      ReportPositionStateThrottled();
      return false;
    }
  }

  if(!SpreadOk(sym)) { LogSkip("spread too high", id); g_lastSignalId=id; return false; }

  if(CooldownActive()) {
    long cdMs = (long)InpCooldownMinutes * 60 * 1000;
    long untilMs = g_lastOpenMs + cdMs;
    ReportCooldownStateThrottled(true, untilMs, "cooldown");
    LogSkip("cooldown active untilMs="+(string)untilMs, id);
    g_lastSignalId=id;
    return false;
  }

  int digits=(int)SymbolInfoInteger(sym,SYMBOL_DIGITS);
  sl = NormalizeDouble(sl, digits);

  ENUM_ORDER_TYPE ot = (dir=="BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL);

  // lotsize
  // AUTO mode sizes lots so that SL hit risks <= InpMaxRiskPercent.
  double riskPct = InpMaxRiskPercent;
  if(riskPct <= 0.0) riskPct = 1.0;

  // Compute allowed lots for riskPct
  double allowedLots = CalcRiskLots(sym, ot, sl, riskPct);
  if(allowedLots <= 0.0) { LogSkip("allowedLots<=0 (risk lots calc failed)", id); g_lastSignalId=id; return false; }

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

  double fixedLots = ClampLots(sym, InpFixedLot);
  if(InpMaxLot > 0.0) fixedLots = MathMin(fixedLots, InpMaxLot);
  fixedLots = ClampLots(sym, fixedLots);

  double lotsTotal = 0.0;
  if(InpUseFixedLot)
  {
    // Fixed lot mode: keep old behavior
    double fixedLots = ClampLots(sym, InpFixedLot);
    if(InpMaxLot > 0.0) fixedLots = MathMin(fixedLots, InpMaxLot);
    fixedLots = ClampLots(sym, fixedLots);

    // If allowedLots is smaller than our fixed lots, then fixed lots would exceed riskPct -> SKIP.
    if(fixedLots > allowedLots + 1e-9)
    {
      if(InpDebugTrade)
        Print("Skip signal (risk too high for fixed lot). id=", id,
              " fixed=", DoubleToString(fixedLots,2),
              " allowed=", DoubleToString(allowedLots,2),
              " maxRisk%=", DoubleToString(riskPct,2));
      g_lastSignalId = id;
      return false;
    }

    lotsTotal = fixedLots;
  }
  else
  {
    // AUTO mode: use risk-based lots (<= riskPct). This makes 100k and 10k both take the trade.
    lotsTotal = allowedLots;
    if(InpMaxLot > 0.0) lotsTotal = MathMin(lotsTotal, InpMaxLot);
    lotsTotal = ClampLots(sym, lotsTotal);
  }

  if(lotsTotal <= 0.0) { LogSkip("lotsTotal<=0 after caps/steps", id); g_lastSignalId=id; return false; }

  double expected = (ot==ORDER_TYPE_BUY) ? SymbolInfoDouble(sym, SYMBOL_ASK) : SymbolInfoDouble(sym, SYMBOL_BID);

  trade.SetExpertMagicNumber(InpMagic);
  trade.SetDeviationInPoints(MaxSlippagePoints > 0 ? MaxSlippagePoints : 30);

  bool okOpen = (ot==ORDER_TYPE_BUY) ? trade.Buy(lotsTotal, sym, 0.0, 0.0, 0.0, comment) : trade.Sell(lotsTotal, sym, 0.0, 0.0, 0.0, comment);
  if(!okOpen) { LogSkip("order open failed: "+trade.ResultRetcodeDescription(), id); g_lastSignalId=id; return false; }

  ulong ticket = (ulong)trade.ResultOrder();
  g_lastOpenMs = NowMsUtc();

  if(InpCooldownMinutes > 0) {
    long untilMs = g_lastOpenMs + (long)InpCooldownMinutes * 60 * 1000;
    ReportCooldownStateThrottled(true, untilMs, "trade_open");
  }

  ReportPositionStateThrottled();
  Sleep(200);

  if(!PositionSelectByTicket(ticket)) {
    if(!PositionSelect(sym)) { LogSkip("cannot select position after open (ticket="+(string)ticket+")", id); g_lastSignalId=id; return false; }
  }

  double entry = PositionGetDouble(POSITION_PRICE_OPEN);
  if(!EntryDistanceOk(sym, expected, entry)) {
    LogSkip("entry distance too far (slippage protection)", id);
    trade.PositionClose(ticket);
    g_lastSignalId=id;
    return false;
  }

  double risk = MathAbs(entry - sl);
  if(risk <= 0.0) { LogSkip("risk<=0 (bad SL vs entry)", id); g_lastSignalId=id; return false; }

  double tp = sigTp;
  if(tp <= 0 || (ot==ORDER_TYPE_BUY && tp <= entry) || (ot==ORDER_TYPE_SELL && tp >= entry))
    tp = (ot == ORDER_TYPE_BUY) ? (entry + (RR * risk)) : (entry - (RR * risk));

  sl = NormalizeDouble(sl, digits);
  tp = NormalizeDouble(tp, digits);

  bool okMod = ModifyStopsWithRetries(sym, ticket, sl, tp);
  if(InpDebugTrade) Print("Stops set okMod=", (okMod?"true":"false"), " entry=", DoubleToString(entry,digits), " sl=", DoubleToString(sl,digits), " tp=", DoubleToString(tp,digits));

  g_lastSignalId = id;

  if(InpEnableExecPost) {
    long nowMs = NowMsUtc();
    string body = "{";
    body += "\"signal_id\":\"" + id + "\"";
    body += ",\"ticket\":\"" + (string)ticket + "\"";
    body += ",\"time\":" + (string)nowMs;
    body += "}";
    int st = HttpPostJson(BuildUrl("/signal/executed"), body);
    if(InpDebugHttp) Print("POST /signal/executed code=", st);
  }

  return true;
}

// ---- Close recap notifier ----
void OnTradeTransaction(const MqlTradeTransaction& trans, const MqlTradeRequest& request, const MqlTradeResult& result)
{
  // Disabled in user EA
  if(!InpEnableClosePost) return;
  if(g_lastSignalId=="") return;

  if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
  ulong deal = trans.deal;
  if(deal == 0) return;
  if(!HistoryDealSelect(deal)) return;

  string sym = HistoryDealGetString(deal, DEAL_SYMBOL);
  if(sym != InpSymbol) return;

  long magic = (long)HistoryDealGetInteger(deal, DEAL_MAGIC);
  if((ulong)magic != InpMagic) return;

  long entryType = HistoryDealGetInteger(deal, DEAL_ENTRY);
  if(entryType != DEAL_ENTRY_OUT) return;

  // De-dupe: only 1 close post per signal id
  if(g_lastClosedSignalId == g_lastSignalId) return;

  long reason = HistoryDealGetInteger(deal, DEAL_REASON);
  string outcome = "CLOSED";
  if(reason == DEAL_REASON_TP) outcome = "TP hit";
  else if(reason == DEAL_REASON_SL) outcome = "SL hit";

  double profit = HistoryDealGetDouble(deal, DEAL_PROFIT);
  double swap   = HistoryDealGetDouble(deal, DEAL_SWAP);
  double comm   = HistoryDealGetDouble(deal, DEAL_COMMISSION);
  double net    = profit + swap + comm;
  string resultStr = DoubleToString(net, 2) + " USD";

  // no /signal/closed posting in user EA
  return;
}

int OnInit() {
  string gv = GVNameSince();
  if(GlobalVariableCheck(gv)) g_sinceMs = (long)GlobalVariableGet(gv);
  else g_sinceMs = NowMsUtc();
  SaveSinceMs();

  g_dailyYmd = (int)(GlobalVariableCheck(GVNameDayYmd()) ? GlobalVariableGet(GVNameDayYmd()) : 0);
  if(GlobalVariableCheck(GVNameDayStartEq())) g_dayStartEquity = GlobalVariableGet(GVNameDayStartEq());
  LoadOrResetDayStartEquity();

  Print("✅ FlexbotUserEA installed OK. Symbol=", InpSymbol,
        " | BaseUrl=", InpBaseUrl,
        " | Risk=", DoubleToString(InpMaxRiskPercent,2), "%",
        " | MaxLot=", DoubleToString(InpMaxLot,2),
        " | PollSec=", (string)InpPollSeconds);
  Print("👉 MT5: Tools→Options→Expert Advisors→Allow WebRequest: add ", InpBaseUrl);
  SetBanner("FLEXBOT USER EA", "Status: STARTING", "Waiting for backend...");
  EventSetTimer(1);
  return INIT_SUCCEEDED;
}

void OnDeinit(const int reason){ EventKillTimer(); RemoveBanner(); }

void OnTimer() {
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
  string url = BuildUrl("/signal/next?symbol=" + InpSymbol + "&since_ms=" + (string)g_sinceMs);
  string body=HttpGetText(url, st);
  if(InpDebugHttp) Print("Next status=",st," url=", url);

  if(st>=200 && st<300)
  {
    if(!g_loggedConnected)
    {
      g_loggedConnected = true;
      Print("✅ FlexbotUserEA connected to backend OK (HTTP ", st, "). Waiting for signals…");
    }
    SetBanner("FLEXBOT USER EA", "Status: CONNECTED", "Waiting for signals...");
  }
  else
  {
    if(!g_loggedConnected)
      Print("❌ FlexbotUserEA cannot reach backend (HTTP ", st, "). Check WebRequest allowlist + URL.");
    SetBanner("FLEXBOT USER EA", "Status: NO CONNECTION", "Fix: Allow WebRequest + check BaseUrl");
    return;
  }

  // If we're in cooldown, show it clearly on-chart
  if(InpCooldownMinutes > 0 && CooldownActive()) {
    long untilMs = g_lastOpenMs + (long)InpCooldownMinutes * 60 * 1000;
    datetime untilT = (datetime)(untilMs/1000);
    SetBanner("FLEXBOT USER EA", "Status: COOLDOWN", "Until: " + TimeToString(untilT, TIME_DATE|TIME_MINUTES));
  }

  ExecuteSignal(body);
}
