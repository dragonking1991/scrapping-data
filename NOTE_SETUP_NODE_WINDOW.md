# NOTE SETUP CHAY SOURCE (WINDOWS + MACOS)

Tai lieu nay huong dan chi tiet tu cai NVM den update Node.js, sau do setup va chay source cho repo nay.

## 1) Link download chinh thuc

### Windows
- NVM for Windows: https://github.com/coreybutler/nvm-windows
- Link release NVM Windows: https://github.com/coreybutler/nvm-windows/releases
- Node.js (neu can cai truc tiep, khong dung NVM): https://nodejs.org/en/download

## 2) Cai NVM

### Windows
1. Vao trang release: https://github.com/coreybutler/nvm-windows/releases
2. Tai file cai dat `nvm-setup.exe` (ban moi nhat)
3. Chay installer voi quyen Admin (nen dung)
4. Mo PowerShell/CMD moi va kiem tra:

```powershell
nvm version
```

## 3) Cai Node.js bang NVM va update Node

### Cai ban LTS moi nhat

Windows (PowerShell/CMD):

```powershell
nvm install lts
nvm use lts
node -v
npm -v
```

### Update Node khi co ban moi

Windows:

```powershell
nvm install lts
nvm use lts
```

Ghi chu:
- Windows NVM thuong khong co co che `--reinstall-packages-from=current` nhu nvm-sh.
- Neu can global package, cai lai sau khi doi version Node.

## 4) Setup source repo nay

Di chuyen vao folder source:

```bash
cd /duong-dan-den/ScrappingData
```

Cai dependency:

```bash
npm install
```

Kiem tra TypeScript compile (khong emit):

```bash
npm run check
```

## 5) Cau hinh bien moi truong

Tao file `.env` tu `.env.example`:

Windows PowerShell:

```powershell
copy .env.example .env
```

Sau do dien cac gia tri can thiet trong `.env` (vi du tai khoan GDT).

## 6) Chay source

### Chay UI dev server

```bash
npm run dev
```

Mo trinh duyet tai:
- http://localhost:4173




## 7) Troubleshooting nhanh

1. `nvm` khong tim thay tren macOS:
- Thu `source ~/.zshrc` roi chay lai.
- Kiem tra da them script NVM vao shell config chua.

2. Windows mo terminal cu van khong co `nvm`:
- Dong het terminal, mo lai terminal moi.
- Neu van loi, restart may sau khi cai NVM.

3. Loi quyen script tren PowerShell:
- Mo PowerShell voi quyen Admin:
```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```

4. Node version sai:
- Chay lai `nvm use lts` (hoac `nvm use --lts` tren macOS)
- Kiem tra `node -v`.


## 8) Khuyen nghi version

- Node.js: LTS moi nhat
- npm: version di kem Node LTS
- Neu co warning package native, uu tien cap nhat Node LTS truoc, roi `npm install` lai.
