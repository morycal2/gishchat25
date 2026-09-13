# Zento v4.30.0 — Railway/PostgreSQL fix

رفع دو خطای Railway:

1. `support_messages.sender_id` دیگر برای سازنده با شناسه مصنوعی `0` ذخیره نمی‌شود؛ پاسخ سازنده در حساب سیستمی `admin` ذخیره می‌شود و FK معتبر می‌ماند.
2. جدول `push_subscriptions` در شروع سرور به‌صورت idempotent ساخته می‌شود و endpoint `/api/push/subscribe` نیز اضافه شده است.

بعد از Deploy، Railway باید با همان PostgreSQL فعلی اجرا شود؛ داده‌های کاربران و پیام‌ها حذف نمی‌شوند.
