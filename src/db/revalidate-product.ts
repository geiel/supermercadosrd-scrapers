const BASE_URL = process.env.REVALIDATE_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
const REVALIDATION_SECRET = process.env.REVALIDATION_SECRET;

export async function revalidateProduct(productId: number) {
  if (!BASE_URL) {
    return;
  }

  try {
    const response = await fetch(`${BASE_URL.replace(/\/$/, "")}/api/revalidate/product`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(REVALIDATION_SECRET
          ? {
              Authorization: `Bearer ${REVALIDATION_SECRET}`,
            }
          : {}),
      },
      body: JSON.stringify({ productId }),
    });

    if (!response.ok) {
      console.error(
        `[REVALIDATE] Failed to revalidate product ${productId}: ${response.status}`
      );
    }
  } catch (error) {
    console.error(`[REVALIDATE] Error revalidating product ${productId}:`, error);
  }
}
