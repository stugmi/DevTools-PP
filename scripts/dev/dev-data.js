// Sample capture for the dev panel and docs screenshots: a synthetic demo shop.
// Self-contained serializable data; nothing here ships in the extension build.
"use strict";

const ASSETS = "https://static.shop.example.com/assets";
const API = "https://api.shop.example.com";

const SOURCES = {
  "src/components/ProductCard.tsx": `import {useState} from 'react'
import {clsx} from 'clsx'
import type {Product} from '../lib/api'
import {formatPrice, formatRating} from '../lib/format'
import {useCart} from '../hooks/useCart'

import styles from './ProductCard.module.css'

type ProductCardProps = {
  product: Product
  compact?: boolean
  onSelect?: (id: string) => void
}

const BADGES = [
  {key: 'new', label: 'New'},
  {key: 'sale', label: 'Sale'},
  {key: 'limited', label: 'Limited'},
]

export function ProductCard({product, compact = false, onSelect}: ProductCardProps) {
  const {addItem, isInCart} = useCart()
  const [adding, setAdding] = useState(false)
  const badge = BADGES.find(({key}) => product.tags.includes(key))

  async function handleAdd() {
    setAdding(true)
    try {
      await addItem({id: product.id, quantity: 1})
    } finally {
      setAdding(false)
    }
  }

  return (
    <article
      className={clsx(styles.card, compact && styles.compact)}
      onClick={() => onSelect?.(product.id)}
    >
      <img className={styles.image} src={product.imageUrl} alt={product.name} loading="lazy" />
      {badge && <span className={styles.badge}>{badge.label}</span>}
      <h3 className={styles.title}>{product.name}</h3>
      <p className={styles.rating}>{formatRating(product.rating, product.reviewCount)}</p>
      <div className={styles.footer}>
        <span className={styles.price}>{formatPrice(product.price, product.currency)}</span>
        <button type="button" disabled={adding || isInCart(product.id)} onClick={handleAdd}>
          {isInCart(product.id) ? 'In cart' : adding ? 'Adding...' : 'Add to cart'}
        </button>
      </div>
    </article>
  )
}
`,
  "src/components/CartDrawer.tsx": `import {useCart} from '../hooks/useCart'
import {formatPrice} from '../lib/format'

export function CartDrawer({open, onClose}: {open: boolean; onClose: () => void}) {
  const {items, total, removeItem} = useCart()
  if (!open) return null
  return (
    <aside className="cart-drawer" aria-label="Shopping cart">
      <header>
        <h2>Your cart</h2>
        <button type="button" onClick={onClose} aria-label="Close cart">x</button>
      </header>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.name} x {item.quantity}
            <button type="button" onClick={() => removeItem(item.id)}>Remove</button>
          </li>
        ))}
      </ul>
      <footer>Total: {formatPrice(total, 'USD')}</footer>
    </aside>
  )
}
`,
  "src/hooks/useCart.ts": `import {useCallback, useEffect, useState} from 'react'
import {fetchCart, updateCart, type CartItem} from '../lib/api'

export function useCart() {
  const [items, setItems] = useState<CartItem[]>([])

  useEffect(() => {
    fetchCart().then(setItems)
  }, [])

  const addItem = useCallback(async (item: {id: string; quantity: number}) => {
    setItems(await updateCart({add: [item]}))
  }, [])

  const removeItem = useCallback(async (id: string) => {
    setItems(await updateCart({remove: [id]}))
  }, [])

  const isInCart = useCallback((id: string) => items.some((item) => item.id === id), [items])
  const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0)

  return {items, total, addItem, removeItem, isInCart}
}
`,
  "src/lib/api.ts": `export type Product = {
  id: string
  name: string
  price: number
  currency: string
  rating: number
  reviewCount: number
  imageUrl: string
  tags: string[]
}

export type CartItem = {id: string; name: string; price: number; quantity: number}

const API_ROOT = 'https://api.shop.example.com'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API_ROOT + path, {credentials: 'include', ...init})
  if (!response.ok) throw new Error(\`\${response.status} \${response.statusText}\`)
  return response.json()
}

export const fetchProducts = (category: string) =>
  request<Product[]>(\`/v2/products?category=\${encodeURIComponent(category)}&limit=24\`)

export const fetchCart = () => request<CartItem[]>('/v2/cart')

export const updateCart = (change: {add?: {id: string; quantity: number}[]; remove?: string[]}) =>
  request<CartItem[]>('/v2/cart', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(change),
  })
`,
  "src/lib/format.ts": `const priceFormatters = new Map<string, Intl.NumberFormat>()

export function formatPrice(amount: number, currency: string) {
  let formatter = priceFormatters.get(currency)
  if (!formatter) {
    formatter = new Intl.NumberFormat(undefined, {style: 'currency', currency})
    priceFormatters.set(currency, formatter)
  }
  return formatter.format(amount / 100)
}

export function formatRating(rating: number, reviews: number) {
  return \`\${rating.toFixed(1)} / 5 (\${reviews.toLocaleString()} reviews)\`
}
`,
  "src/pages/Catalog.tsx": `import {useEffect, useState} from 'react'
import {ProductCard} from '../components/ProductCard'
import {fetchProducts, type Product} from '../lib/api'

export default function Catalog({category}: {category: string}) {
  const [products, setProducts] = useState<Product[]>([])
  useEffect(() => {
    fetchProducts(category).then(setProducts)
  }, [category])
  return (
    <section className="catalog">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} />
      ))}
    </section>
  )
}
`,
  "src/pages/Checkout.tsx": `import {CartDrawer} from '../components/CartDrawer'
import {useCart} from '../hooks/useCart'

export default function Checkout() {
  const {items} = useCart()
  return <CartDrawer open={items.length > 0} onClose={() => history.back()} />
}
`,
  "src/components/ProductCard.module.css": `.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: 8px;
  background: var(--surface);
}

.badge {
  position: absolute;
  top: 8px;
  left: 8px;
  padding: 2px 6px;
  color: white;
  background: var(--accent);
}

.price {
  font-weight: 600;
}
`,
  "src/main.tsx": `import {createRoot} from 'react-dom/client'
import Catalog from './pages/Catalog'

createRoot(document.getElementById('root')!).render(<Catalog category="shoes" />)
`,
  "node_modules/react/index.d.ts": `export function useState<S>(initial: S | (() => S)): [S, (value: S | ((prev: S) => S)) => void]
export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
export function useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly unknown[]): T
`,
  "node_modules/clsx/clsx.d.ts": `export type ClassValue = string | number | boolean | null | undefined | ClassValue[] | Record<string, unknown>
export function clsx(...inputs: ClassValue[]): string
export default clsx
`,
};

const PRODUCTS = [
  {
    id: "sku_10482",
    name: "Trail Runner GTX",
    price: 12999,
    currency: "USD",
    rating: 4.6,
    reviewCount: 1284,
    imageUrl: "https://cdn.shop.example.com/p/10482.webp",
    tags: ["new"],
  },
  {
    id: "sku_10519",
    name: "City Sneaker Low",
    price: 8999,
    currency: "USD",
    rating: 4.3,
    reviewCount: 532,
    imageUrl: "https://cdn.shop.example.com/p/10519.webp",
    tags: ["sale"],
  },
  {
    id: "sku_10611",
    name: "Ultralight Racer",
    price: 15999,
    currency: "USD",
    rating: 4.8,
    reviewCount: 2210,
    imageUrl: "https://cdn.shop.example.com/p/10611.webp",
    tags: [],
  },
];

const header = (name, value) => ({ name, value });
const json = (value) => JSON.stringify(value);

function sampleBundle() {
  const names = Object.keys(SOURCES);
  const map = {
    version: 3,
    file: "main.js",
    sources: names.map((name) => "../../" + name),
    sourcesContent: names.map((name) => SOURCES[name]),
    names: [],
    // One segment per line: generated line N maps to the start of source N.
    mappings: names.map((_, i) => (i === 0 ? "AAAA" : "ACAA")).join(";"),
  };
  const mapUrl =
    "data:application/json;base64," + Buffer.from(JSON.stringify(map), "utf8").toString("base64");
  return (
    names
      .map((name, i) => "/* " + i + " */function m" + i + "(){return " + JSON.stringify(name) + "}")
      .join("\n") +
    "\n//# sourceMappingURL=" +
    mapUrl
  );
}

// A protobuf-like recommendations payload for the hex viewer.
function protobufBytes() {
  const bytes = [];
  const pushString = (field, text) => {
    const encoded = [...new TextEncoder().encode(text)];
    bytes.push((field << 3) | 2, encoded.length, ...encoded);
  };
  for (const product of PRODUCTS) {
    pushString(1, product.id);
    pushString(2, product.name);
    bytes.push(
      (3 << 3) | 0,
      (product.price & 0x7f) | 0x80,
      ((product.price >> 7) & 0x7f) | 0x80,
      product.price >> 14
    );
    bytes.push((4 << 3) | 5, 0x9a, 0x99, 0x93, 0x40);
  }
  return bytes;
}

function createSampleCapture() {
  const resource = (url, type, content) => ({ url, type, content });
  const resources = [
    resource(
      "https://shop.example.com/",
      "document",
      '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <title>Example Shop</title>\n  <link rel="stylesheet" href="https://static.shop.example.com/assets/main.css">\n</head>\n<body>\n  <div id="root"></div>\n  <script type="module" src="https://static.shop.example.com/assets/main.js"></script>\n</body>\n</html>\n'
    ),
    resource(ASSETS + "/main.js", "script", sampleBundle()),
    resource(
      ASSETS + "/vendor.min.js",
      "script",
      'var e=require("react");function t(n){return n&&n.__esModule?n:{default:n}}var r=t(e);export{r as React};'
    ),
    resource(
      ASSETS + "/main.css",
      "stylesheet",
      ".card{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:8px}.badge{position:absolute;top:8px;left:8px}"
    ),
    resource(
      "https://shop.example.com/manifest.json",
      "manifest",
      '{"name":"Example Shop","start_url":"/","display":"standalone"}'
    ),
    resource(
      "https://cdn.shop.example.com/img/logo.svg",
      "image",
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10"/></svg>'
    ),
    resource("https://cdn.shop.example.com/img/hero.webp", "image", ""),
    resource("https://fonts.example.net/inter/Inter-Variable.woff2", "font", ""),
    resource(
      "https://www.googletagmanager.com/gtag/js",
      "script",
      "(function(){window.dataLayer=window.dataLayer||[]})();"
    ),
  ];

  const now = Date.UTC(2025, 10, 7, 12, 0, 0);
  let offset = 0;
  const stack = (frames) => ({
    type: "script",
    stack: {
      callFrames: frames.map(([functionName, line]) => ({
        functionName,
        url: ASSETS + "/main.js",
        lineNumber: line,
        columnNumber: 0,
      })),
    },
  });
  function entry({
    url,
    method = "GET",
    status = 200,
    type = "fetch",
    mime = "application/json",
    body = "",
    encoding,
    request = {},
    time = 40,
    initiator,
    error,
    size,
  }) {
    offset += 37;
    const responseHeaders = [
      header("content-type", mime),
      header("cache-control", "private, max-age=0"),
      header("date", new Date(now).toUTCString()),
      header("server", "envoy"),
      header("x-request-id", "7f3c9a2e-" + (1000 + offset)),
    ];
    return {
      startedDateTime: new Date(now - 60000 + offset * 10).toISOString(),
      time,
      _resourceType: type,
      _initiator: initiator,
      ...(error ? { _error: error } : {}),
      serverIPAddress: "203.0.113.24",
      request: {
        method,
        url,
        httpVersion: "h2",
        headers: [
          header(":authority", new URL(url).host),
          header("accept", "application/json, text/plain, */*"),
          header("accept-language", "en-US,en;q=0.9"),
          header("origin", "https://shop.example.com"),
          header("referer", "https://shop.example.com/catalog/shoes"),
          header("sec-ch-ua-platform", '"Windows"'),
          header(
            "user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
          ),
          ...(request.headers || []),
        ],
        queryString: [...new URL(url).searchParams].map(([name, value]) => ({ name, value })),
        cookies: [{ name: "session", value: "s%3A9f1c2b7e4d" }],
        ...(request.postData
          ? { postData: request.postData, bodySize: request.postData.text.length }
          : { bodySize: 0 }),
      },
      response: {
        status,
        statusText: status === 200 ? "OK" : status === 0 ? "" : "Error",
        httpVersion: "h2",
        headers: status ? responseHeaders : [],
        cookies: [],
        content: {
          size: size ?? body.length,
          mimeType: mime,
          ...(body ? { text: body } : {}),
          ...(encoding ? { encoding } : {}),
        },
        bodySize: size ?? body.length,
      },
      timings: {
        blocked: 1.2,
        dns: 0,
        connect: 0,
        ssl: 0,
        send: 0.3,
        wait: time - 6,
        receive: 4.5,
      },
    };
  }

  const proto = protobufBytes();
  const cart = [{ id: "sku_10611", name: "Ultralight Racer", price: 15999, quantity: 1 }];
  const requests = [
    entry({
      url: "https://shop.example.com/catalog/shoes",
      type: "document",
      mime: "text/html",
      body: '<!doctype html>\n<html lang="en"><head><title>Example Shop</title></head><body><div id="root"></div></body></html>',
      time: 182,
    }),
    entry({
      url: API + "/v2/products?category=shoes&limit=24",
      body: json({ items: PRODUCTS, total: 3, nextCursor: null }),
      time: 64,
      initiator: stack([
        ["request", 1],
        ["fetchProducts", 4],
        ["Catalog", 5],
      ]),
    }),
    entry({
      url: API + "/v2/cart",
      body: json(cart),
      time: 38,
      initiator: stack([
        ["request", 1],
        ["fetchCart", 4],
        ["useCart", 2],
      ]),
    }),
    entry({
      url: API + "/graphql",
      method: "POST",
      time: 91,
      request: {
        headers: [header("content-type", "application/json")],
        postData: {
          mimeType: "application/json",
          text: json({
            operationName: "ProductReviews",
            variables: { productId: "sku_10482", first: 5 },
            query:
              "query ProductReviews($productId: ID!, $first: Int!) { product(id: $productId) { reviews(first: $first) { nodes { id rating title author { name } } } } }",
          }),
        },
      },
      body: json({
        data: {
          product: {
            reviews: {
              nodes: [
                {
                  id: "rev_1",
                  rating: 5,
                  title: "Great grip on wet trails",
                  author: { name: "Sam" },
                },
                {
                  id: "rev_2",
                  rating: 4,
                  title: "Runs a little narrow",
                  author: { name: "Priya" },
                },
              ],
            },
          },
        },
      }),
      initiator: stack([
        ["request", 1],
        ["loadReviews", 3],
      ]),
    }),
    entry({
      url: API + "/v2/cart",
      method: "POST",
      time: 72,
      request: {
        headers: [header("content-type", "application/json")],
        postData: {
          mimeType: "application/json",
          text: json({ add: [{ id: "sku_10482", quantity: 1 }] }),
        },
      },
      body: json([
        ...cart,
        { id: "sku_10482", name: "Trail Runner GTX", price: 12999, quantity: 1 },
      ]),
      initiator: stack([
        ["request", 1],
        ["updateCart", 4],
        ["addItem", 2],
        ["handleAdd", 0],
      ]),
    }),
    entry({
      url: API + "/v1/recommendations?user=u_58213",
      mime: "application/x-protobuf",
      body: Buffer.from(proto).toString("base64"),
      encoding: "base64",
      size: proto.length,
      time: 55,
    }),
    entry({
      url: "https://cdn.shop.example.com/p/10482.webp",
      type: "image",
      mime: "image/webp",
      time: 23,
    }),
    entry({
      url: "https://www.google-analytics.com/g/collect?v=2&tid=G-EXAMPLE&en=view_item",
      method: "POST",
      status: 0,
      type: "ping",
      mime: "text/plain",
      time: 3,
      error: "net::ERR_BLOCKED_BY_CLIENT",
    }),
    entry({
      url: API + "/v2/events",
      method: "POST",
      status: 204,
      mime: "text/plain",
      time: 18,
      request: {
        headers: [header("content-type", "text/plain;charset=UTF-8")],
        postData: {
          mimeType: "text/plain;charset=UTF-8",
          text: '{"type":"view","sku":"sku_10482","ts":1762500000123}\n{"type":"add_to_cart","sku":"sku_10482","ts":1762500004321}',
        },
      },
    }),
  ];

  // Plain data only; the dev bridge exposes bodies through chrome.devtools callbacks.
  return { resources, requests };
}

module.exports = { createSampleCapture };
