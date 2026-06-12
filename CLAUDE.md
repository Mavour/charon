\# Solana Trench Agent - Development Guide



Dokumen ini berisi instruksi build, perintah penting, dan panduan logika untuk Claude Agent dalam mengoptimalkan bot trenching meme-coin di Solana.



\## 1. Development \& Build Commands

\* \*\*Install Dependencies:\*\* `npm install` atau `yarn install`

\* \*\*Build Project:\*\* `npm run build` atau `tsc` (sesuaikan dengan bundler yang digunakan)

\* \*\*Run Agent/Bot:\*\* `npm run start` atau `node dist/index.js`

\* \*\*Run Tests:\*\* `npm run test`



---



\## 2. Core Objective: Smart Trenching Logic

Tujuan utama proyek ini adalah membuat agen menjadi sangat pintar dalam melakukan \*trenching\* (mencari koin baru rilis/skala mikro) di ekosistem Solana (Raydium, Pump.fun, Jupiter) dan menemukan koin berpotensi naik (\*10x-100x potential\*).



Saat memperbaiki atau menulis ulang fungsi logika, pastikan agen menerapkan kriteria berikut:



\### Kriteria Filter Koin Bagus (Anti-Rug \& High Potential)

1\. \*\*Developer Wallet Analysis:\*\* Periksa riwayat dev. Apakah dev sering melakukan \*rug pull\* di proyek sebelumnya? Berapa persen suplai yang dipegang dev? (Maksimal 5-10%).

2\. \*\*Liquidity \& Burn/Lock:\*\* Pastikan likuiditas awal sudah di-burn 100% atau dikunci (\*locked\*). Jangan sentuh koin yang likuiditasnya bisa ditarik kapan saja.

3\. \*\*Social Metrics \& Bundles:\*\* Periksa apakah ada indikasi \*sniping\* massal menggunakan \*bundle\* (Jito). Analisis aktivitas Twitter/X dan Telegram secara instan jika API tersedia.

4\. \*\*Top Holders Distribution:\*\* Pastikan tidak ada segelintir \*wallet\* misterius yang menguasai lebih dari 20% total suplai di luar wallet bursa/likuiditas.

5\. \*\*Volume \& Momentum:\*\* Deteksi lonjakan volume beli (\*green candles\*) organik dalam hitungan menit/detik pertama setelah rilis di \*trench\*.



---



\## 3. Code Quality Guidelines

\* \*\*Language:\*\* TypeScript/JavaScript (Node.js).

\* \*\*Solana RPC:\*\* Gunakan penanganan \*error\* yang ketat untuk \*rate-limit\* RPC (karena jaringan Solana sering \*congested\*). Selalu gunakan fallback RPC atau Jito MEV jika diperlukan untuk eksekusi cepat.

\* \*\*Math Safety:\*\* Gunakan `BigInt` atau library BN.js / BigNumber.js untuk perhitungan desimal token Solana agar tidak terjadi \*floating-point error\*.

\* \*\*State Management:\*\* Pastikan logika \*scanning\* koin tidak menyebabkan \*memory leak\* karena memantau ratusan token baru per menit.

