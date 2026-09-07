# Zento Stage 4

نسخه 7.4 قابلیت‌های پیشرفته زیر را اضافه می‌کند:

1. **Multi-device Sync** — نشست‌های همزمان یک حساب، رویدادهای گفتگو را لحظه‌ای دریافت می‌کنند.
2. **Bot API** — ساخت ربات و توکن از داخل زنتو و endpoint ارسال پیام.
3. **Mini Apps** — اجرای Mini Appهای HTTPS درون پنجره زنتو.
4. **Real-time Game** — بازی دوز دو نفره با Socket.IO.
5. **Screen Share** — اشتراک صفحه در تماس تصویری.
6. **AI** — دستیار داخلی با endpoint سازگار با Chat Completions؛ نیازمند تنظیم AI_API_URL، AI_API_KEY و AI_MODEL.
7. **PWA** — manifest + service worker + نصب مستقیم در مرورگرهای پشتیبان.

## Railway

پس از push/deploy، متغیرهای قبلی پروژه را نگه دار و برای AI در صورت نیاز سه متغیر بالا را اضافه کن. هیچ کلید AI یا Supabase service-role را داخل `public/` قرار نده.
