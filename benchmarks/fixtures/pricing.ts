export interface PriceLine {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export interface PriceSummary {
  subtotal: number;
  discount: number;
  total: number;
}

export function calculateTotal(lines: PriceLine[]): PriceSummary {
  let subtotal = 0;
  for (const line of lines) {
    if (!Number.isInteger(line.quantity) || line.quantity < 0) {
      throw new RangeError('Invalid quantity.');
    }
    if (!Number.isFinite(line.unitPrice) || line.unitPrice < 0) {
      throw new RangeError('Invalid unit price.');
    }
    subtotal += line.quantity * line.unitPrice;
  }
  const discountRate = subtotal >= 100 ? 0.1 : 0;
  const discount = Math.round(subtotal * discountRate * 100) / 100;
  const total = Math.round((subtotal - discount) * 100) / 100;
  return { subtotal, discount, total };
}

export function formatSummary(summary: PriceSummary): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  });
  const lines = [
    `Subtotal: ${formatter.format(summary.subtotal)}`,
    `Discount: ${formatter.format(summary.discount)}`,
    `Total: ${formatter.format(summary.total)}`,
  ];
  return lines.join('\n');
}

export function mergeLines(lines: PriceLine[]): PriceLine[] {
  const merged = new Map<string, PriceLine>();
  for (const line of lines) {
    const key = `${line.productId}:${line.unitPrice}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += line.quantity;
    } else {
      merged.set(key, { ...line });
    }
  }
  return [...merged.values()];
}

export function splitTax(total: number, taxRate: number): { net: number; tax: number } {
  if (!Number.isFinite(total) || total < 0) {
    throw new RangeError('Invalid total.');
  }
  if (!Number.isFinite(taxRate) || taxRate < 0) {
    throw new RangeError('Invalid tax rate.');
  }
  const net = Math.round(total / (1 + taxRate) * 100) / 100;
  return { net, tax: Math.round((total - net) * 100) / 100 };
}

export function allocateCredit(lines: PriceLine[], credit: number): number[] {
  const values = lines.map((line) => line.quantity * line.unitPrice);
  const sum = values.reduce((accumulator, value) => accumulator + value, 0);
  if (sum === 0) return values.map(() => 0);
  const available = Math.max(0, Math.min(credit, sum));
  return values.map((value) => Math.round(available * value / sum * 100) / 100);
}

export function hasDuplicateProducts(lines: PriceLine[]): boolean {
  const seen = new Set<string>();
  for (const line of lines) {
    if (seen.has(line.productId)) return true;
    seen.add(line.productId);
  }
  return false;
}
