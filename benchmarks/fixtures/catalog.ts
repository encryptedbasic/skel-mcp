export interface CatalogItem {
  id: string;
  name: string;
  priceCents: number;
  tags: string[];
  available: boolean;
}

export interface CatalogFilter {
  query?: string;
  tag?: string;
  availableOnly?: boolean;
  maximumPriceCents?: number;
}

export type AddItemResult =
  | { ok: true; item: CatalogItem }
  | { ok: false; reason: string };

export class Catalog {
  private readonly items = new Map<string, CatalogItem>();

  constructor(initialItems: CatalogItem[] = []) {
    for (const item of initialItems) {
      const result = this.add(item);
      if (!result.ok) throw new Error(result.reason);
    }
  }

  add(item: CatalogItem): AddItemResult {
    const id = item.id.trim();
    if (!id) return { ok: false, reason: 'Item id is required.' };
    if (this.items.has(id)) {
      return { ok: false, reason: `Item ${id} already exists.` };
    }
    if (!Number.isInteger(item.priceCents) || item.priceCents < 0) {
      return { ok: false, reason: 'Price must be non-negative integer cents.' };
    }
    const normalized = {
      ...item,
      id,
      name: item.name.trim(),
      tags: this.normalizeTags(item.tags),
    };
    this.items.set(id, normalized);
    return { ok: true, item: { ...normalized, tags: [...normalized.tags] } };
  }

  find(id: string): CatalogItem | undefined {
    const item = this.items.get(id.trim());
    return item ? { ...item, tags: [...item.tags] } : undefined;
  }

  list(filter: CatalogFilter = {}): CatalogItem[] {
    const query = filter.query?.trim().toLowerCase();
    const tag = filter.tag?.trim().toLowerCase();
    const matching = [...this.items.values()].filter((item) => {
      if (filter.availableOnly && !item.available) return false;
      if (query && !item.name.toLowerCase().includes(query)) return false;
      if (tag && !item.tags.includes(tag)) return false;
      if (filter.maximumPriceCents !== undefined
          && item.priceCents > filter.maximumPriceCents) return false;
      return true;
    });
    matching.sort((first, second) => first.name.localeCompare(second.name));
    return matching.map((item) => ({ ...item, tags: [...item.tags] }));
  }

  remove(id: string): boolean {
    const normalizedId = id.trim();
    if (!normalizedId) return false;
    return this.items.delete(normalizedId);
  }

  private normalizeTags(tags: string[]): string[] {
    const normalized = tags.map((tag) => tag.trim().toLowerCase());
    return [...new Set(normalized.filter(Boolean))].sort();
  }
}

export function formatPrice(priceCents: number, currency = 'USD'): string {
  if (!Number.isInteger(priceCents) || priceCents < 0) {
    throw new RangeError('Invalid price in cents.');
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
  }).format(priceCents / 100);
}
