const BASE_URL = process.env.REVALIDATE_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
const REVALIDATION_SECRET = process.env.REVALIDATION_SECRET;
const REVALIDATE_SECRET_HEADER = "x-revalidate-secret";

export async function revalidateProduct(productId: number) {
  if (!BASE_URL) {
    return;
  }

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (REVALIDATION_SECRET) {
      headers.Authorization = `Bearer ${REVALIDATION_SECRET}`;
      headers[REVALIDATE_SECRET_HEADER] = REVALIDATION_SECRET;
    }

    const response = await fetch(`${BASE_URL.replace(/\/$/, "")}/api/revalidate/product`, {
      method: "POST",
      headers,
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
