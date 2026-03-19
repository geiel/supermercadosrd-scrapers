ALTER TABLE "products"
ADD COLUMN IF NOT EXISTS "image" text;

CREATE TABLE IF NOT EXISTS "product_images" (
  "productId" integer NOT NULL,
  "imageUrl" text NOT NULL,
  "hidden" boolean NOT NULL DEFAULT false,
  "primary" boolean NOT NULL DEFAULT false,
  CONSTRAINT "product_images_productId_imageUrl_pk" PRIMARY KEY ("productId", "imageUrl")
);

CREATE TABLE IF NOT EXISTS "product_broken_images" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "productId" integer NOT NULL,
  "imageUrl" text NOT NULL,
  "reportedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "isFixed" boolean DEFAULT false
);
