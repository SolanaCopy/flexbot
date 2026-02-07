# Flexbot MT5 EA (Signals → Market Orders)

This EA polls the Flexbot backend and executes XAUUSD signals as **market orders**.

## What it does
- Polls: `GET /signal/next?symbol=XAUUSD`
- When a new signal arrives:
  - Opens **3 positions** (partials) with **TP1/TP2/TP3**
  - Split: **50% / 30% / 20%** (TP1/TP2/TP3)
  - Uses **1% of account balance** risk per signal (configurable)
  - Sets SL from the signal
- Optionally posts an execution receipt: `POST /signal/executed`

## Install
1. Open **MetaEditor** (from MT5).
2. Create a new folder: `MQL5/Experts/Flexbot/`
3. Copy `FlexbotSignalEA.mq5` into that folder.
4. Compile.

## MT5 settings (required)
- MT5: **Tools → Options → Expert Advisors**
  - Enable **Allow algorithmic trading**
  - Enable **Allow WebRequest for listed URL**
  - Add:
    - `https://flexbot-qpf2.onrender.com`

## Inputs (defaults)
- `InpBaseUrl`: `https://flexbot-qpf2.onrender.com`
- `InpSymbol`: `XAUUSD`
- `InpRiskPercent`: `1.0`
- `InpPollSeconds`: `5`
- `InpMagic`: `8210317741`

## Notes
- Lot sizing is computed from **risk% + SL distance** using symbol tick value/size.
- This is safer than a fixed lot multiplier and automatically scales across accounts.
