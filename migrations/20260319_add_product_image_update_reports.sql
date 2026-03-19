CREATE TABLE IF NOT EXISTS "product_image_update_reports" (
  "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  "productId" integer NOT NULL,
  "beforeImageUrl" text NOT NULL,
  "afterImageUrl" text NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now()
);
