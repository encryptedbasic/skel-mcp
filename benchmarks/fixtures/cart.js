export function createCart(customerId) {
  if (typeof customerId !== 'string' || !customerId.trim()) {
    throw new TypeError('A customer id is required.');
  }
  return { customerId: customerId.trim(), items: [], coupon: null };
}

export function addCartItem(cart, product) {
  if (!product.sku || !Number.isFinite(product.price) || product.price < 0) {
    throw new TypeError('Invalid product.');
  }
  const existing = cart.items.find((item) => item.sku === product.sku);
  if (existing) {
    existing.quantity += 1;
  } else {
    cart.items.push({
      sku: product.sku,
      title: product.title.trim(),
      price: product.price,
      quantity: 1,
    });
  }
  return cart;
}

export function setCartQuantity(cart, sku, quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) {
    throw new RangeError('Quantity must be a non-negative integer.');
  }
  const item = cart.items.find((candidate) => candidate.sku === sku);
  if (!item) return false;
  if (quantity === 0) {
    cart.items = cart.items.filter((candidate) => candidate.sku !== sku);
  } else {
    item.quantity = quantity;
  }
  return true;
}

export function getCartTotal(items, discountPercent = 0) {
  if (!Number.isFinite(discountPercent)
      || discountPercent < 0 || discountPercent > 100) {
    throw new RangeError('Discount must be between zero and one hundred.');
  }
  let subtotal = 0;
  for (const item of items) {
    if (!Number.isFinite(item.price) || item.price < 0) {
      throw new RangeError('Item price must be non-negative.');
    }
    if (!Number.isInteger(item.quantity) || item.quantity < 0) {
      throw new RangeError('Item quantity must be a non-negative integer.');
    }
    subtotal += item.price * item.quantity;
  }
  const discounted = subtotal * (1 - discountPercent / 100);
  return Math.round((discounted + Number.EPSILON) * 100) / 100;
}

export function applyCoupon(cart, coupon, now = new Date()) {
  if (new Date(coupon.expiresAt) <= now) {
    return { applied: false, reason: 'expired' };
  }
  if (coupon.minimumItems > cart.items.length) {
    return { applied: false, reason: 'minimum-items' };
  }
  cart.coupon = { code: coupon.code, discountPercent: coupon.discountPercent };
  return { applied: true, reason: null };
}

export function summarizeCart(cart) {
  const quantity = cart.items.reduce((count, item) => count + item.quantity, 0);
  const discount = cart.coupon?.discountPercent ?? 0;
  return {
    customerId: cart.customerId,
    distinctProducts: cart.items.length,
    quantity,
    coupon: cart.coupon?.code ?? null,
    total: getCartTotal(cart.items, discount),
  };
}

export function serializeCart(cart) {
  return JSON.stringify({
    customerId: cart.customerId,
    items: cart.items.map(({ sku, price, quantity }) => ({ sku, price, quantity })),
    coupon: cart.coupon,
  });
}

export function clearCart(cart) {
  const previousCount = cart.items.length;
  cart.items = [];
  cart.coupon = null;
  return previousCount;
}
