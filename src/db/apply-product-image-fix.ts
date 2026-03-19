import { and, eq } from "drizzle-orm";
import { db } from "./client.js";
import {
  productBrokenImages,
  productImages,
  productImageUpdateReports,
  products,
  type ProductImageRow,
} from "./schema.js";
import { revalidateProduct } from "./revalidate-product.js";

export async function deleteBrokenImageReportsByImage(
  productId: number,
  imageUrl: string
) {
  await db
    .delete(productBrokenImages)
    .where(
      and(
        eq(productBrokenImages.productId, productId),
        eq(productBrokenImages.imageUrl, imageUrl)
      )
    );
}

type ApplyProductImageFixInput = {
  productId: number;
  reportedImageUrl: string;
  replacementImageUrl: string;
  productTableImageUrl: string | null;
  shouldSyncProductTableImageAsPrimary: boolean;
  shouldUpdateProductTable: boolean;
  productTableProductImageRow: Pick<ProductImageRow, "imageUrl" | "hidden" | "primary"> | null;
  brokenProductImageRow: Pick<ProductImageRow, "imageUrl" | "hidden" | "primary"> | null;
  replacementProductImageRow: Pick<ProductImageRow, "imageUrl" | "hidden" | "primary"> | null;
};

export async function applyProductImageFix({
  productId,
  reportedImageUrl,
  replacementImageUrl,
  productTableImageUrl,
  shouldSyncProductTableImageAsPrimary,
  shouldUpdateProductTable,
  productTableProductImageRow,
  brokenProductImageRow,
  replacementProductImageRow,
}: ApplyProductImageFixInput) {
  const normalizedReplacementImageUrl = replacementImageUrl.trim();
  const normalizedProductTableImageUrl = productTableImageUrl?.trim() || null;

  if (!normalizedReplacementImageUrl) {
    throw new Error("A valid replacement image is required to fix the product.");
  }

  const normalizedBeforeImageUrl =
    brokenProductImageRow?.imageUrl.trim() || reportedImageUrl.trim();

  await db.transaction(async (tx) => {
    if (shouldSyncProductTableImageAsPrimary && normalizedProductTableImageUrl) {
      if (!productTableProductImageRow) {
        await tx.insert(productImages).values({
          productId,
          imageUrl: normalizedProductTableImageUrl,
          hidden: false,
          primary: true,
        });
      } else {
        await tx
          .update(productImages)
          .set({ primary: true })
          .where(
            and(
              eq(productImages.productId, productId),
              eq(productImages.imageUrl, normalizedProductTableImageUrl)
            )
          );
      }

      await tx
        .update(productImages)
        .set({ primary: false })
        .where(
          and(
            eq(productImages.productId, productId),
            eq(productImages.primary, true)
          )
        );

      await tx
        .update(productImages)
        .set({ primary: true })
        .where(
          and(
            eq(productImages.productId, productId),
            eq(productImages.imageUrl, normalizedProductTableImageUrl)
          )
        );
    }

    if (brokenProductImageRow) {
      if (!replacementProductImageRow) {
        await tx.insert(productImages).values({
          productId,
          imageUrl: normalizedReplacementImageUrl,
          hidden: brokenProductImageRow.hidden,
          primary: brokenProductImageRow.primary,
        });
      }

      await tx
        .delete(productImages)
        .where(
          and(
            eq(productImages.productId, productId),
            eq(productImages.imageUrl, brokenProductImageRow.imageUrl)
          )
        );
    }

    if (shouldUpdateProductTable) {
      await tx
        .update(products)
        .set({ image: normalizedReplacementImageUrl })
        .where(eq(products.id, productId));
    }

    await tx.insert(productImageUpdateReports).values({
      productId,
      beforeImageUrl: normalizedBeforeImageUrl,
      afterImageUrl: normalizedReplacementImageUrl,
    });

    await tx
      .delete(productBrokenImages)
      .where(
        and(
          eq(productBrokenImages.productId, productId),
          eq(productBrokenImages.imageUrl, reportedImageUrl)
        )
      );
  });

  await revalidateProduct(productId);
}
