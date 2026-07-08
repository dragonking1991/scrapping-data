## Why

Nguoi dung can tach luong lay hoa don mua vao theo 3 nhom trang thai ma (hasCode, noCode, initCode) ngay tu UI de xuat dung file json theo tung nhom va tranh tron du lieu. Nhu cau nay can co ngay de quy trinh tong hop xlsx tao dung ket qua cho tung nhom mua vao thay vi mot file gop.

## What Changes

- Them UI checkbox "Mua vao" va dropdown 3 lua chon: `hasCode`, `noCode`, `initCode`.
- Dat mac dinh dropdown la `hasCode` khi checkbox duoc bat.
- Cap nhat hanh vi nut "Lay thong tin":
  - Neu khong bat checkbox thi van xuat vao `hd_sold.json`.
  - Neu bat checkbox thi xuat vao mot trong cac file `hd_purchased_hasCode.json`, `hd_purchased_noCode.json`, `hd_purchased_initCode.json` theo lua chon.
- Cap nhat luong tong hop de tao ket qua mua vao thanh 3 nhom va ghi vao file `hd_purchased_merged.xlsx` voi 3 sheet `hasCode`, `noCode`, `initCode`.
- Bo sung log de the hien ro ket qua khop/khong khop theo tung nhom mua vao.

## Capabilities

### New Capabilities
- `purchased-mode-selection-and-aggregation`: Cung cap che do chon nhom mua vao tren UI, dinh tuyen file json xuat theo nhom, va tong hop xlsx mua vao thanh 3 sheet theo nhom.

### Modified Capabilities
- (none)

## Impact

- UI web: `src/ui/web/index.html`, `src/ui/web/app.js`.
- Xu ly backend/routing cho run va aggregate: `src/ui/routes-processing.ts`, cac module lien quan den xuat json.
- Luong merge xlsx: `src/ui/jobs-aggregate.ts`, `src/export/merge.ts` (hoac module merge lien quan).
- Du lieu dau ra: them cac file json mua vao theo nhom va thay doi cau truc ket qua `hd_purchased_merged.xlsx`.
