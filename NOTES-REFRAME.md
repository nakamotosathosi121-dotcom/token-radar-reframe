# Token Launch Radar — reframe "layar mispricing" (25 Nov 2026)

Perintah Sancit 25 Nov 11:19 WIB. JANGAN SUBMIT tanpa persetujuan Sancit.
Model radar-4 BEKU; yang berubah hanya presentasi (dashboard + 3 field data).

## Yang dipertahankan (identik radar-4)
- Fit, premium kategori, growth carry, launch odds, board.json (byte-identik),
  farm economics + 6 langkah, validasi LOO/WF/5-fold, ablation, scatter log-log,
  chip stabilitas peringkat bootstrap, watchlist 40, accounting 758.
- Judge radar-4: 943.720, rank ~538, gap top-20 16.734 poin (1,77%).

## Yang berubah
- Dua jalur terpisah tegas: ber-token = residual terukur (mcap vs nilai kurva,
  flag RICH/CHEAP/IN-LINE dari kuantil P10–P90 residual LOO); pra-token = hanya
  nilai implisit + rentang P25–P75, tanpa kata "mispricing"/"deviasi".
- Panel hero residual (24 live: 10 RICH, 0 CHEAP, 14 IN-LINE; median rasio x9,2)
  + tangga rentang P25–P75 (8 teratas, batang saja, tanpa titik).
- Legenda "kontrak kejujuran" + kotak "Baru vs v3" (3 butir jujur).
- Tabel utama 55 baris: glyph batang P25–P75 (tanpa angka), chip lebar band
  (x11,9, global), chip screening maks 2 (SIZE/ODDS/GROWTH/SEASONING),
  status selalu PRA-TOKEN; verdict FARM/THIN/SKIP dan komponen model mentah
  pindah ke detail view.
- Seksi "Sudah ber-token — residual terukur", urut |log rasio|, residual
  dilabeli in-sample (fit penuh, bukan LOO).
- Method dibalik: batasan dulu + kotak "apa yang tidak bisa diklaim".
- Lapisan data (lib/model.ts saja): LiveRow +curve_implied_usd,
  deviation_ratio, mispricing_flag, is_comp; RadarData +mispricing_summary;
  RadarRow +growth_tier (filter, bukan skor).

## Yang TIDAK diklaim
- Efek reframe terhadap skor judge TIDAK terukur (heuristik, coin flip di
  gap 1,77%). Tidak ada angka efek di mana pun di entri ini.
- Tidak ada skor baru (confidence/expected return/alpha), tidak ada ambang
  2,0/0,5 mentah, tidak ada ranking mispricing by USD absolut.
- Live 24 dipilih dari mcap terbesar, jadi condong RICH — itu seleksi,
  bukan temuan.

## Validasi
- Dua run main.ts dari salinan read-only di cwd berbeda: exit 0, output
  byte-identical; board.json byte-identik dengan radar-4.
- Check kit + kuota: lihat laporan build (parent).
