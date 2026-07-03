# scrape-gdt-invoices

CLI TypeScript/Node de tra cuu hoa don GDT va bo sung cot "Ten hang hoa, dich vu" vao file xlsx.

## Cai dat

```bash
npm install
```

## Cau hinh

Copy `.env.example` thanh `.env`, sau do dien thong tin:

- `GDT_USERNAME`
- `GDT_PASSWORD`

Khong commit file `.env` va `.token.json`.

## Chay

```bash
npm run dev
```

Chay UI web (Tailwind) de nhap `from`, `to`, `out` bang form:

```bash
npm run dev
```

Sau do mo `http://localhost:4173`.

Neu muon chay truc tiep bang CLI (khong qua UI):

```bash
npm run dev:cli -- --from 05/05/2026 --to 31/05/2026 --out ./DANH-SACH-HOA-DON.xlsx
```

Hoac build va chay:

```bash
npm run build
npm start -- --from 05/05/2026 --to 31/05/2026 --out ./DANH-SACH-HOA-DON.xlsx
```

## Tuy chon

- `--relogin`: bo cache token, dang nhap lai
- `--no-cache`: khong doc/ghi token cache
- `--type <invoice|ticket>`: chon loai hoa don
- `--manual-first`: mo browser va cho nguoi dung thao tac login/captcha/tim kiem thu cong
- `--verify-only`: chi verify endpoint, khong ghi file

Bien moi truong lien quan captcha:

- `GDT_CAPTCHA_MODE=auto|manual`: `manual` se bo qua OCR va cho ban tu nhap captcha tren browser.

## Luu y

- Pipeline su dung browser cho buoc login/captcha, sau do goi API JSON cho list/detail/export.
- Manual-first mode co checkpoint (`GDT_CHECKPOINT_PATH`) de resume tien do khi session het han.
- Neu endpoint export thay doi, cap nhat `GDT_EXPORT_ENDPOINTS`.
