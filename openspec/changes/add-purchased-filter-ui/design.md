## Context

UI hien tai chi co mot luong "Lay thong tin" va xuat du lieu theo file sold/purchased mac dinh, chua co co che phan loai mua vao theo trang thai ma hoa don. Dieu nay lam cho du lieu mua vao bi tron, kho tong hop va doi chieu theo nhu cau van hanh (hasCode, noCode, initCode).

Thay doi nay cat ngang qua 3 lop:
- Frontend UI: bo sung control de nguoi dung bat/tat luong mua vao va chon loai.
- Luong run/export JSON: dieu huong ten file dau ra theo lua chon UI.
- Luong aggregate XLSX: tong hop purchased theo 3 nhom rieng va xuat thanh 3 sheet.

Rang buoc chinh:
- Giu nguyen hanh vi cu khi khong bat checkbox (mac dinh sold).
- Khong pha vo duong dan va ten file dang duoc script van hanh su dung.
- Can log duoc ket qua khop/khong khop theo tung nhom de de kiem tra.

## Goals / Non-Goals

**Goals:**
- Them checkbox "Mua vao" va dropdown lua chon `hasCode`, `noCode`, `initCode` tren UI.
- Dinh tuyen file JSON dau ra theo trang thai control:
  - Unchecked -> `hd_sold.json`.
  - Checked + hasCode -> `hd_purchased_hasCode.json`.
  - Checked + noCode -> `hd_purchased_noCode.json`.
  - Checked + initCode -> `hd_purchased_initCode.json`.
- Khi aggregate, tao `hd_purchased_merged.xlsx` gom 3 sheet `hasCode`, `noCode`, `initCode` voi du lieu dung nhom.
- Ghi log danh sach ID hoa don khop/khong khop theo tung nhom purchased.

**Non-Goals:**
- Khong thay doi luong dang nhap, pagination, hay quy trinh mo hoa don tren GDT.
- Khong thay doi format file `hd_sold.xlsx` hay cach merge sold hien tai.
- Khong bo sung dashboard thong ke moi ngoai cac trang thai/log hien co.

## Decisions

1. Them state mode purchased o frontend va gui kem payload `/run`.
- Quyết định: Payload `/run` bo sung truong mode (sold | purchased-hasCode | purchased-noCode | purchased-initCode) duoc suy ra tu checkbox + dropdown.
- Ly do: Tranh phai suy luan o backend tu cac truong roi rac, giam coupling UI/backend.
- Alternative can nhac: Gui 2 truong `isPurchased` + `purchasedType`; khong chon vi backend van phai map them va de sai namespace.

2. Chuan hoa map mode -> ten file json o backend.
- Quyết định: Tao bang map tap trung trong luong export de quyet dinh file dau ra duy nhat.
- Ly do: Tranh hardcode nhieu noi va de test bang data-driven.
- Alternative can nhac: if/else tai moi call site; khong chon vi kho bao tri.

3. Aggregate purchased theo 3 pipeline doc lap roi ghi vao 3 sheet.
- Quyết định: Chay xu ly merge cho tung file JSON purchased (`hasCode`, `noCode`, `initCode`), sau do ghi vao workbook purchased voi 3 sheet co ten co dinh.
- Ly do: Dam bao moi nhom co ket qua rieng, de doi chieu va tranh lan du lieu.
- Alternative can nhac: Gop 1 sheet co cot type; khong chon vi yeu cau nghiep vu can tach sheet.

4. Log ket qua chi tiet theo nhom sau khi aggregate xong.
- Quyết định: In tong so matched/unmatched va danh sach invoice keys cho moi nhom.
- Ly do: Ho tro debug nhanh khi doi chieu file json va xlsx.
- Alternative can nhac: Log tong hop chung mot lan; khong chon vi kho truy vet theo nhom.

## Risks / Trade-offs

- [Risk] UI state moi co the gui mode khong hop le -> Mitigation: validate mode o backend va fallback ro rang (tra loi 400).
- [Risk] Thieu file JSON o mot nhom purchased -> Mitigation: danh dau nhom do la skipped/failed voi message ro rang, nhung van xu ly cac nhom con lai.
- [Risk] Workbook purchased co the bi ghi de sai cau truc sheet -> Mitigation: tao API merge ro rang cho multi-sheet, kiem thu ten sheet va so dong moi sheet.
- [Risk] Danh sach ID qua dai lam log kho doc -> Mitigation: giu tong so + danh sach day du trong log hien tai; co the cat gon o UI neu can sau.
