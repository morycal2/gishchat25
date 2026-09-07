# Gish Chat 6.1 — Railway + Supabase

نسخه‌ی ارتقایافته‌ی Gish Chat با رابط الهام‌گرفته از پیام‌رسان‌های مدرن و Telegram، بدون وابستگی به رفرش صفحه برای پیام‌های جدید.

## امکانات این نسخه
- اعلان خطا داخل خود سایت (Toast) به‌جای `alert` مرورگر.
- پیام‌رسانی لحظه‌ای با Socket.IO و نمایش فوری پیام ارسال‌شده.
- گروه و کانال با مدیریت مالک/ادمین/مدیر میانی، افزودن و حذف ادمین و حذف عضو.
- پنل تنظیمات تفکیک‌شده برای اعلان‌ها، داده و رسانه، حریم خصوصی، امنیت و ظاهر.
- صفحه/پنل مستقل «پیام‌های ذخیره‌شده» شبیه Saved Messages.
- پنل سه‌بخشی ایموجی، GIF و استیکر.
- ساخت GIF کوتاه از ویدیو در مرورگر با gif.js و آپلود آن به Storage.
- ساخت/آپلود استیکر از تصویر و ارسال مستقیم در چت.
- دانلود رسانه‌ها (عکس، ویدیو، صدا، فایل، GIF و استیکر) از مسیر امن Backend.
- ضبط پیام صوتی با MediaRecorder.
- تماس صوتی/تصویری WebRTC با UI جدید و signaling توسط Socket.IO.
- واکنش، پاسخ به پیام، حذف پیام و جستجوی کاربر.
- طراحی responsive برای موبایل و دسکتاپ + حالت شب.
- سازگاری با دیتابیس‌های قدیمی users و password/password_hash.
- `trust proxy` برای رفع خطای Railway و express-rate-limit.

## متغیرهای محیطی Railway
- `DATABASE_URL` — connection string پستگرس Supabase (برای شبکه IPv4 بهتر است از pooler استفاده شود).
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `JWT_SECRET`
- `FRONTEND_ORIGIN` — آدرس فرانت‌اند در صورت جدا بودن از Backend.
- `STORAGE_BUCKET` اختیاری، پیش‌فرض `gish-files`.

## اجرا
```bash
npm install
npm start
```

اگر فرانت‌اند روی GitHub Pages است، مقدار `API_URL` را در `public/config.js` روی آدرس Railway قرار بده.
