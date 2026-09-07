# Gish Chat v6 — GitHub Pages + Render + Supabase

نسخه حرفه‌ای‌تر گیش چت، با جداسازی کامل Frontend و Backend:

- **Frontend:** GitHub Pages
- **Backend:** Render Web Service (Node.js + Express + Socket.IO)
- **Database:** Supabase PostgreSQL
- **File storage:** Supabase Storage
- **Auth:** JWT + bcrypt
- **Realtime:** Socket.IO
- **Uploads:** بدون دیسک محلی؛ فایل‌ها مستقیماً در Object Storage ذخیره می‌شوند.

## 1) ساخت دیتابیس و Storage در Supabase

در Supabase یک پروژه بساز و فایل `supabase/schema.sql` را در SQL Editor اجرا کن. این فایل جداول کاربران، گفتگوها، اعضا، پیام‌ها، ذخیره‌ها، بلاک‌ها و گزارش‌ها را می‌سازد و Bucket عمومی `gish-files` را برای رسانه‌ها ایجاد می‌کند.

از Supabase این دو مقدار را بردار:

- Project URL → `SUPABASE_URL`
- `service_role` API key → `SUPABASE_SERVICE_ROLE_KEY`

همچنین از بخش Database، `DATABASE_URL` را بردار. کلید service role فقط باید روی Backend بماند.

## 2) Deploy Backend روی Render

Repository را به Render وصل کن و Blueprint را از `render.yaml` بساز. این متغیرها را در Environment وارد کن:

```text
DATABASE_URL=...
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
FRONTEND_ORIGIN=https://morycal2.github.io
```

`JWT_SECRET` توسط Render ساخته می‌شود.

بعد از Deploy، آدرس سرویس مثلاً:

```text
https://gish-chat-backend.onrender.com
```

خواهد بود. آدرس `/health` باید JSON با `ok: true` برگرداند.

## 3) اتصال GitHub Pages

در `public/config.js` مقدار `API_URL` را با آدرس واقعی Render جایگزین کن:

```js
window.GISH_CONFIG={API_URL:'https://YOUR-SERVICE.onrender.com'};
```

سپس push کن. Workflow داخل `.github/workflows/pages.yml` پوشه `public/` را روی GitHub Pages منتشر می‌کند.

## 4) مهاجرت داده‌های قدیمی

اگر `data/gish.json` نسخه قبلی را داری، آن را داخل پروژه در همین مسیر قرار بده و پس از تنظیم `.env` اجرا کن:

```bash
npm ci
npm run migrate:json
```

اسکریپت کاربران، گفتگوها، اعضا، پیام‌ها، saved messages، بلاک‌ها و گزارش‌ها را به PostgreSQL منتقل می‌کند.

## 5) اجرای محلی

```bash
cp .env.example .env
npm ci
npm start
```

سپس `http://localhost:3000` را باز کن.

## نکته درباره «رایگان و دائمی»

این معماری دیگر به دیسک محلی Render وابسته نیست؛ بنابراین restart/deploy بک‌اند فایل‌ها و داده‌های اصلی را از بین نمی‌برد. با این حال «رایگان» به معنی تضمین دائمی نیست: Render Free Web Service محدودیت‌های خود را دارد و Free Postgres خود Render بعد از ۳۰ روز منقضی می‌شود، به همین دلیل این نسخه PostgreSQL و Storage را روی Supabase نگه می‌دارد. Supabase Free فعلاً ۵۰۰MB دیتابیس و ۱GB Storage دارد و پروژه‌های بدون فعالیت پس از یک هفته pause می‌شوند. برای داده‌های مهم، بکاپ مستقل توصیه می‌شود.
