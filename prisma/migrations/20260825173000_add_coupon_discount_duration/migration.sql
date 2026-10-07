CREATE TYPE "CouponDiscountDuration" AS ENUM ('FIRST_CYCLE', 'RECURRING');

ALTER TABLE "SalesReferralCode"
ADD COLUMN "discountDuration" "CouponDiscountDuration" NOT NULL DEFAULT 'FIRST_CYCLE';

ALTER TABLE "CouponCampaign"
ADD COLUMN "discountDuration" "CouponDiscountDuration" NOT NULL DEFAULT 'FIRST_CYCLE';

ALTER TABLE "user_subscriptions"
ADD COLUMN "renewalAmount" DECIMAL(12,2),
ADD COLUMN "couponDiscountDuration" "CouponDiscountDuration";
