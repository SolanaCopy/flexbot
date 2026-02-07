//+------------------------------------------------------------------+
//|                                              FlexbotSignalEA.mq5 |
//|  Polls Flexbot backend for the latest signal and executes it.    |
//|  Designed for XAUUSD market orders with 3 TPs and 1% risk.       |
//+------------------------------------------------------------------+
#property strict

#include <Trade/Trade.mqh>

CTrade trade;

// ===== Inputs =====
input string  InpBaseUrl          = "https://flexbot-qpf2.onrender.com"; // no trailing slash
input string  InpSymbol           = "XAUUSD";
input double  InpRiskPercent      = 1.0;     // % of balance risked per signal
input int     InpPollSeconds      = 5;
input ulong   InpMagic            = 8210317741;
input bool    InpUseSignalRiskPct = false;   // if true: uses min(signal.risk_pct, InpRiskPercent)
input bool    InpEnableExecPost   = true;    // POST /signal/executed after opening

// ===== Internal =====
ulong g_lastPollMs = 0;
string g_lastSignalId = "";

// --- helpers ---
string Trim(const string s)
{
  string r = s;
  StringTrimLeft(r);
  StringTrimRight(r);
  return r;
}

bool StartsWith(const string s, const string prefix)
{
  if(StringLen(s) < StringLen(prefix)) return false;
  return StringSubstr(s, 0, StringLen(prefix)) == prefix;
}

string JsonUnescape(string s)
{
  // minimal unescape
  s = StringReplace(s, "\\\"", "\"");
  s = StringReplace(s, "\\n", "\n");
  s = StringReplace(s, "\\r", "\r");
  s = StringReplace(s, "\\t", "\t");
  s = StringReplace(s, "\\\\", "\\");
  return s;
}

bool JsonGetString(const string json, const string key, string &out)
{
  out = "";
  string pat = "\"" + key + "\":";
  int i = StringFind(json, pat);
  if(i < 0) return false;
  i += StringLen(pat);

  // skip spaces
  while(i < StringLen(json))
  {
    ushort c = StringGetCharacter(json, i);
    if(c!=' ' && c!='\n' && c!='\r' && c!='\t') break;
    i++;
  }

  if(i >= StringLen(json) || StringGetCharacter(json,i)!='\"') return false;
  i++;

  int start = i;
  bool esc=false;
  for(; i < StringLen(json); i++)
  {
    ushort c = StringGetCharacter(json, i);
    if(esc) { esc=false; continue; }
    if(c=='\\') { esc=true; continue; }
    if(c=='\"') break;
  }
  if(i >= StringLen(json)) return false;

  out = StringSubstr(json, start, i-start);
  out = JsonUnescape(out);
  return true;
}

bool JsonGetNumber(const string json, const string key, double &out)
{
  out = 0.0;
  string pat = "\"" + key + "\":";
  int i = StringFind(json, pat);
  if(i < 0) return false;
  i += StringLen(pat);

  while(i < StringLen(json))
  {
    ushort c = StringGetCharacter(json, i);
    if(c!=' ' && c!='\n' && c!='\r' && c!='\t') break;
    i++;
  }

  int start = i;
  for(; i < StringLen(json); i++)
  {
    ushort c = StringGetCharacter(json, i);
    if((c>='0' && c<='9') || c=='-' || c=='+' || c=='.' || c=='e' || c=='E') continue;
    break;
  }
  string num = Trim(StringSubstr(json, start, i-start));
  if(num=="" || num=="null") return false;
  out = StringToDouble(num);
  return true;
}

bool JsonGetBool(const string json, const string key, bool &out)
{
  out = false;
  string pat = "\"" + key + "\":";
  int i = StringFind(json, pat);
  if(i < 0) return false;
  i += StringLen(pat);

  while(i < StringLen(json))
  {
    ushort c = StringGetCharacter(json, i);
    if(c!=' ' && c!='\n' && c!='\r' && c!='\t') break;
    i++;
  }

  if(StringSubstr(json, i, 4) == "true") { out=true; return true; }
  if(StringSubstr(json, i, 5) == "false") { out=false; return true; }
  return false;
}

bool JsonGetArrayNumbers(const string json, const string key, double &a, double &b, double &c)
{
  a=b=c=0.0;
  string pat = "\"" + key + "\":";
  int i = StringFind(json, pat);
  if(i < 0) return false;
  i += StringLen(pat);

  while(i < StringLen(json))
  {
    ushort ch = StringGetCharacter(json, i);
    if(ch!=' ' && ch!='\n' && ch!='\r' && ch!='\t') break;
    i++;
  }

  if(i >= StringLen(json) || StringGetCharacter(json,i)!='[') return false;
  int start = i;
  int depth = 0;
  for(; i < StringLen(json); i++)
  {
    ushort ch = StringGetCharacter(json, i);
    if(ch=='[') depth++;
    if(ch==']') { depth--; if(depth==0) { i++; break; } }
  }
  if(depth!=0) return false;

  string arr = StringSubstr(json, start+1, (i-1)-(start+1));
  // split by comma
  string parts[];
  int n = StringSplit(arr, ',', parts);
  if(n < 1) return false;
  a = (n>=1 ? StringToDouble(Trim(parts[0])) : 0.0);
  b = (n>=2 ? StringToDouble(Trim(parts[1])) : 0.0);
  c = (n>=3 ? StringToDouble(Trim(parts[2])) : 0.0);
  return true;
}

string HttpGetText(const string url, int &httpStatus)
{
  httpStatus = 0;
  char result[];
  string headers;
  char data[];

  ResetLastError();
  int timeout = 8000;
  int res = WebRequest("GET", url, headers, timeout, data, result, headers);
  if(res == -1)
  {
    Print("WebRequest GET failed. err=", GetLastError(), " url=", url);
    return "";
  }

  httpStatus = res;
  string body = CharArrayToString(result);
  return body;
}

int HttpPostJson(const string url, const string jsonBody)
{
  char post[];
  StringToCharArray(jsonBody, post);
  char result[];
  string headers = "Content-Type: application/json\r\n";

  ResetLastError();
  int timeout = 8000;
  int res = WebRequest("POST", url, headers, timeout, post, result, headers);
  if(res == -1)
  {
    Print("WebRequest POST failed. err=", GetLastError(), " url=", url);
    return -1;
  }
  return res;
}

double ClampLots(string symbol, double lots)
{
  double minLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
  double maxLot = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
  double step   = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);

  if(lots < minLot) lots = minLot;
  if(lots > maxLot) lots = maxLot;

  // normalize to step
  double steps = MathFloor(lots / step + 1e-9);
  double norm = steps * step;
  if(norm < minLot) norm = minLot;

  // round to 2 decimals (most brokers)
  norm = NormalizeDouble(norm, 2);
  return norm;
}

double CalcRiskLots(string symbol, ENUM_ORDER_TYPE orderType, double slPrice, double riskPercent)
{
  double balance = AccountInfoDouble(ACCOUNT_BALANCE);
  double riskMoney = balance * (riskPercent / 100.0);

  double price = 0;
  if(orderType == ORDER_TYPE_BUY)
    price = SymbolInfoDouble(symbol, SYMBOL_ASK);
  else
    price = SymbolInfoDouble(symbol, SYMBOL_BID);

  double tickSize  = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
  double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);

  if(tickSize <= 0 || tickValue <= 0)
  {
    Print("Bad tickSize/tickValue for ", symbol, " tickSize=", tickSize, " tickValue=", tickValue);
    return 0.0;
  }

  double slDist = MathAbs(price - slPrice);
  if(slDist <= 0)
  {
    Print("Bad SL distance (0)");
    return 0.0;
  }

  // loss per 1.0 lot if SL is hit
  double lossPerLot = (slDist / tickSize) * tickValue;
  if(lossPerLot <= 0) return 0.0;

  double lots = riskMoney / lossPerLot;
  lots = ClampLots(symbol, lots);
  return lots;
}

bool HasOpenPositionsForSignal(string signalId)
{
  // For now: dedupe by lastSignalId only.
  return (signalId != "" && signalId == g_lastSignalId);
}

string BuildUrl(const string pathAndQuery)
{
  string base = InpBaseUrl;
  base = Trim(base);
  if(StringLen(base) > 0 && StringGetCharacter(base, StringLen(base)-1) == '/')
    base = StringSubstr(base, 0, StringLen(base)-1);

  if(StringLen(pathAndQuery) > 0 && StringGetCharacter(pathAndQuery, 0) != '/')
    return base + "/" + pathAndQuery;
  return base + pathAndQuery;
}

bool ExecuteSignal(const string signalJson)
{
  // signalJson contains the entire response; find "signal":{...}
  int si = StringFind(signalJson, "\"signal\"");
  if(si < 0) return false;

  // If signal null -> nothing to do
  int nullIdx = StringFind(signalJson, "\"signal\":null");
  if(nullIdx >= 0) return false;

  string id, sym, dir, comment;
  double sl=0, tp1=0, tp2=0, tp3=0, risk_pct=0;

  if(!JsonGetString(signalJson, "id", id)) return false;
  if(!JsonGetString(signalJson, "symbol", sym)) sym = InpSymbol;
  JsonGetString(signalJson, "direction", dir);
  JsonGetString(signalJson, "comment", comment);

  JsonGetNumber(signalJson, "sl", sl);
  JsonGetNumber(signalJson, "risk_pct", risk_pct);
  JsonGetArrayNumbers(signalJson, "tp", tp1, tp2, tp3);

  sym = Trim(sym);
  if(sym == "") sym = InpSymbol;

  if(HasOpenPositionsForSignal(id))
  {
    Print("Signal already processed: ", id);
    return false;
  }

  if(dir != "BUY" && dir != "SELL")
  {
    Print("Bad direction: ", dir);
    return false;
  }

  if(sl <= 0 || tp1 <= 0)
  {
    Print("Bad SL/TP");
    return false;
  }

  // ensure symbol selected
  if(!SymbolSelect(sym, true))
  {
    Print("SymbolSelect failed for ", sym);
    return false;
  }

  int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
  sl  = NormalizeDouble(sl, digits);
  tp1 = NormalizeDouble(tp1, digits);
  if(tp2 > 0) tp2 = NormalizeDouble(tp2, digits);
  if(tp3 > 0) tp3 = NormalizeDouble(tp3, digits);

  ENUM_ORDER_TYPE ot = (dir == "BUY" ? ORDER_TYPE_BUY : ORDER_TYPE_SELL);

  double risk = InpRiskPercent;
  if(InpUseSignalRiskPct && risk_pct > 0)
    risk = MathMin(risk, risk_pct);

  double lotsTotal = CalcRiskLots(sym, ot, sl, risk);
  if(lotsTotal <= 0)
  {
    Print("CalcRiskLots returned 0");
    return false;
  }

  // Split into 3 positions (TP1/TP2/TP3) using 50/30/20
  double minLot = SymbolInfoDouble(sym, SYMBOL_VOLUME_MIN);

  double l1 = ClampLots(sym, lotsTotal * 0.50);
  double l2 = ClampLots(sym, lotsTotal * 0.30);
  double l3 = lotsTotal - l1 - l2;
  l3 = ClampLots(sym, l3);

  // If rounding collapsed, fallback to single position (TP3)
  if(l3 < minLot)
  {
    l1 = 0;
    l2 = 0;
    l3 = ClampLots(sym, lotsTotal);
  }

  trade.SetExpertMagicNumber(InpMagic);
  trade.SetDeviationInPoints(30);

  bool okAny = false;
  ulong ticket1=0, ticket2=0, ticket3=0;

  // Position 1 TP1
  if(l1 > 0)
  {
    bool ok = false;
    if(ot == ORDER_TYPE_BUY) ok = trade.Buy(l1, sym, 0.0, sl, tp1, comment);
    else ok = trade.Sell(l1, sym, 0.0, sl, tp1, comment);

    if(ok) { okAny = true; ticket1 = (ulong)trade.ResultOrder(); }
    else   { Print("Order1 failed: ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription()); }
  }

  // Position 2 TP2
  if(l2 > 0 && tp2 > 0)
  {
    bool ok = false;
    if(ot == ORDER_TYPE_BUY) ok = trade.Buy(l2, sym, 0.0, sl, tp2, comment);
    else ok = trade.Sell(l2, sym, 0.0, sl, tp2, comment);

    if(ok) { okAny = true; ticket2 = (ulong)trade.ResultOrder(); }
    else   { Print("Order2 failed: ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription()); }
  }

  // Position 3 TP3
  if(l3 > 0 && tp3 > 0)
  {
    bool ok = false;
    if(ot == ORDER_TYPE_BUY) ok = trade.Buy(l3, sym, 0.0, sl, tp3, comment);
    else ok = trade.Sell(l3, sym, 0.0, sl, tp3, comment);

    if(ok) { okAny = true; ticket3 = (ulong)trade.ResultOrder(); }
    else   { Print("Order3 failed: ", trade.ResultRetcode(), " ", trade.ResultRetcodeDescription()); }
  }

  if(!okAny)
    return false;

  // Mark as processed
  g_lastSignalId = id;
  GlobalVariableSet("FlexbotLastSignalId", (double)StringToInteger(id)); // best-effort; may overflow

  if(InpEnableExecPost)
  {
    // Post one execution record (best-effort) with ticket1 if present else any.
    ulong t = (ticket1!=0 ? ticket1 : (ticket2!=0 ? ticket2 : ticket3));
    double fill = 0.0;
    if(PositionSelect(sym)) fill = PositionGetDouble(POSITION_PRICE_OPEN);

    string body = "{";
    body += "\"signal_id\":\"" + id + "\"";
    body += ",\"ticket\":\"" + (string)t + "\"";
    body += ",\"fill_price\":" + DoubleToString(fill, digits);
    body += ",\"time\":" + (string)TimeCurrent();
    body += "}";

    string url = BuildUrl("/signal/executed");
    int st = HttpPostJson(url, body);
    if(st < 200 || st >= 300)
      Print("/signal/executed POST status=", st);
  }

  return true;
}

int OnInit()
{
  // Load last signal id (best-effort)
  if(GlobalVariableCheck("FlexbotLastSignalId"))
  {
    double v = GlobalVariableGet("FlexbotLastSignalId");
    // can't reliably restore string id; keep empty to avoid blocking
  }

  Print("FlexbotSignalEA initialized. BaseUrl=", InpBaseUrl, " Symbol=", InpSymbol);
  EventSetTimer(1);
  return(INIT_SUCCEEDED);
}

void OnDeinit(const int reason)
{
  EventKillTimer();
}

void OnTimer()
{
  ulong nowMs = (ulong)(GetMicrosecondCount()/1000);
  if(g_lastPollMs != 0 && nowMs - g_lastPollMs < (ulong)InpPollSeconds*1000) return;
  g_lastPollMs = nowMs;

  string url = BuildUrl("/signal/next?symbol=" + InpSymbol);
  int st = 0;
  string body = HttpGetText(url, st);

  if(st < 200 || st >= 300)
  {
    Print("GET /signal/next status=", st, " body=", body);
    return;
  }

  if(StringFind(body, "\"signal\":null") >= 0) return;

  ExecuteSignal(body);
}
