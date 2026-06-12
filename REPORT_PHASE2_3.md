# 🚀 Phase 2 & 3: Momentum Scorer + Bundle Detector - Report
**Date:** 2026-06-12

---

## ✅ Phase 2: Volume Momentum Scorer (`src/enrichment/momentum.js`)

### Apa yang Dilakukan
- Analisis candle 5 menit dari Jupiter Data API
- Hitung perubahan volume, buy/sell ratio, price velocity, acceleration
- Deteksi **volume pump & dump** pattern
- Analisis holder growth rate dari GMGN
- Liquidity health scoring (liquidity vs mcap ratio)
- Composite momentum score 0-100
- Klasifikasi: `strong` | `moderate` | `weak` | `dead`

### Signal Baru
| Signal | Arti |
|--------|------|
| `volume_pump_dump` | Volume spike lalu crash = pump & dump |
| `volume_surge` | Volume naik >100% |
| `volume_crash` | Volume turun >50% |
| `holder_exodus` | Holder kabur >20% |
| `accelerating` | Price naik semakin cepat |
| `decelerating` | Momentum melambat |
| `liquidity_thin` | Liquidity < 5% dari MCAP |

### Quick Filter Rules
- Score < 25 + gak organic → Hard reject
- Volume drop > 60% → Hard reject
- Volume pump & dump → Hard reject
- Holder decline > 20% → Hard reject

---

## ✅ Phase 3: Bundle & Sniper Detector (`src/enrichment/bundleDetector.js`)

### Apa yang Dilakukan
- Fetch token transfer history via Solana RPC
- Analisis bundle pattern (banyak txn di slot yang sama)
- Deteksi sniper ratio (berapa % txn di menit pertama)
- Kombinasi dengan GMGN bundler_rate data
- Bundle score 0-100

### Signal Baru
| Signal | Arti |
|--------|------|
| `confirmed_bundle_attack` | GMGN bundler_rate > 50% + on-chain confirm |
| `fresh_token_with_sniper_flood` | Token baru + sniper > 70% |
| `onchain_slots_heavy` | Banyak txn di slot yang sama (bundle) |
| `first_minute_sniper_heavy` | >70% txn di menit pertama |
| `mostly_new_wallets` | 80%+ holder wallet baru (bot farm) |

### Quick Filter Rules
- Bundle score > 60 → Hard reject
- GMGN bundler > 50% + on-chain > 20% → Hard reject
- Token baru (< 30 menit) + sniper heavy → Hard reject

---

## 🔗 Integration ke Bot

### candidateBuilder.js Update
```
buildCandidate() sekarang fetch:
1. Phase 1: RugCheck + Tax + DevWallet (concurrent)
2. Phase 2: Momentum (Jupiter candles + GMGN holders)
3. Phase 3: Bundle Score (RPC transfers + GMGN bundler_rate)
```

### filterCandidate() Update
```
Failures baru:
- momentum_score too low
- volume_pump_dump_detected
- volume_drop
- holder_exodus
- bundle_score too high
- fresh_token_with_sniper_flood
- confirmed_bundle_attack
```

### LLM Prompt Update
```
Weight baru: 20% untuk RUG & SECURITY
Soft flags baru:
- Momentum score < 30 → -20
- Volume pump & dump → -15
- Bundle score 60+ → -25 atau AUTO-PASS
- First minute txn > 30 → -15

Fields bartu dikirim ke LLM:
- momentum.score, momentum.isOrganic, momentum.volumePumpDump
- bundle.score, bundle.isBundled, bundle.firstMinuteTxns
```

---

## 📊 Arsitektur Bot Sekarang

```
Signal (feed_claim/graduated/trending)
   ↓
buildCandidate()
   ├── Phase 1: Rug Defense
   │   ├── RugCheck score
   │   ├── LP burn/lock
   │   ├── Mint/freeze authority
   │   ├── Tax & honeypot
   │   └── Dev wallet history
   ├── Phase 2: Momentum
   │   ├── Candle analysis (5m)
   │   ├── Volume trend
   │   ├── Holder growth
   │   └── Liquidity health
   ├── Phase 3: Bundle
   │   ├── Transfer history
   │   ├── Slot clustering
   │   ├── Sniper ratio
   │   └── GMGN bundler_rate
   └── Phase 4: Adaptive (soon)
       └── (evaluasi dari trade history)
   ↓
filterCandidate() → HARD REJECT kalau ada violation
   ↓
LLM Decision → dengan semua Phase 1-3 signals
   ↓
Execution (dry_run / live)
   ↓
Position Monitoring
```

---

## ⚙️ Setting Baru via Telegram

| Command | Default | Deskripsi |
|---------|---------|-----------|
| `max_bundle_score` | 60 | Reject bundle score > 60 |
| `momentum_volume_drop_pct` | 60 | Reject volume drop > 60% |
| `rugcheck_max_score` | 200 | Reject rugcheck > 200 |
| `max_total_tax_percent` | 15 | Reject tax > 15% |
| `max_dev_rug_score` | 70 | Reject dev score > 70 |
| `require_lp_safe` | true | Check LP burned/locked |
| `require_mint_revoked` | false | (relaxed untuk sniper) |
| `require_freeze_revoked` | false | (relaxed untuk sniper) |

---

## 🔄 Next: Phase 4 Adaptive Learning

Saya sudah bikin file evaluasi: `PHASE4_EVALUATION.md`

**Kesimpulan evaluasi:**
- ✅ **Phase 4 WORTH IT** diimplementasikan
- ❌ **Gak butuh model AI lebih pintar**
- ✅ **Rule-based auto-tune** cukup
- 🛡️ **Suggest-only mode** paling aman untuk awal

### Contoh Adaptive
```
Kalau win rate < 15% (last 20 trades):
  - Turunkan max_mcap_usd 20%
  - Naikkan llm_min_confidence 5-10 poin
  - Naikkan min_holders 50-100

Kalau strategy X selalu SL:
  - Suggest switch strategy ke Y

Kalau signal source Z selalu profit:
  - Naikkan weight signal source Z
```

---

## 📁 File Baru

| File | Fungsi |
|------|--------|
| `src/enrichment/rugcheck.js` | RugCheck.xyz API + LP check |
| `src/enrichment/security.js` | Tax + honeypot detector |
| `src/enrichment/devWallet.js` | Dev history analyzer |
| `src/enrichment/momentum.js` | Volume + price momentum |
| `src/enrichment/bundleDetector.js` | Bundle + sniper detector |

---

## ✅ Semua Syntax Check Pass
```
✅ rugcheck.js     OK
✅ security.js     OK
✅ devWallet.js    OK
✅ momentum.js     OK
✅ bundleDetector.js OK
✅ candidateBuilder.js OK
✅ llm.js          OK
✅ connection.js   OK
✅ positions.js    OK
```

---

**Phase 1 + 2 + 3 SELESAI. Bot sekarang punya 5 sapnu baru:**
1. 🔒 RugCheck defense
2. 💰 Tax & honeypot check
3. 👤 Dev wallet history
4. 📈 Volume momentum scoring
5. 🎯 Bundle & sniper detection
