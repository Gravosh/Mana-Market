# Mana Market

A small personal MTG card finder with a local helper for live shop lookups. It needs no account, paid hosting, or additional packages.

## Start using it

1. Double-click `Start Mana Market.cmd`. It starts the local helper and opens the app in your browser. Leave the small minimized helper window running while you use the app.
2. Keep or remove the example Fizzy Hobby Store entry, and add any other shops by name and website address.
3. Enter a card name in the first field, then choose **Add card** for each additional card. The app searches up to 100 cards per batch.
4. Review the results; for shops without a live connection, choose **Search** in that shop's row to open its web listings.
5. Choose **Save** on a card result to add that card to your wishlist, then open the **Wishlist** page in the top navigation.

Your shop list and wishlist are stored in this browser on this device. The card lookup and images need an internet connection; they use Scryfall's public card API. Search supports up to 100 card fields at a time.

## What this first version does

- Looks up card names and thumbnail images with Scryfall.
- Shows one row per searched card and one column per shop. Each store column starts with that shop's cheapest available printing; remove it from the results to reveal the next cheapest. Out-of-stock printings appear only when none are available.
- Provides separate Search and Wishlist pages. The Wishlist page saves cards by name, independent of the store row they were saved from, and shows a price column for every configured shop.
- Shows a web search link for shops without a verified connector.
- When a shop is added, checks for a public Shopify catalog and saves a live connector when the storefront responds in the expected format. Other shops are still saved for manual search.
- Lets you add and remove shops and save or remove wishlist cards.
- Keeps your shop list and wishlist locally in browser storage.

## Price and availability limitations

Fizzy Hobby Store is connected through its public card API. Lung Ji is connected through its public Archidekt collection. Yannick is connected through the product search endpoint used by its public singles catalog, with each condition variant's live price and inventory quantity. Power 9 is connected through Shopify's public product search and product details. Sabai Card is connected through its public singles catalog, reading the live listing price in Thai baht (THB), its listed inventory quantity, card image, and product page; the connector searches all result pages and matches the card's original name. Hobby Bugong is connected through its public MTG singles API. It checks regular and foil printings, searches all pages, and uses the lowest priced in-stock condition and its exact quantity; if all printings are out of stock, it shows the lowest listed condition. Power 9 prefers the in-stock Near Mint price shown by the shop and reports availability in Thai baht (THB); exact stock counts are not public. Power 9's suggestion endpoint returns up to 10 matches, so it may omit some printings and cannot guarantee the cheapest version across the entire catalog. Lung Ji's collection data is cached for at most one minute; Yannick, Power 9, Sabai Card, and Hobby Bugong are queried on each search. Prices and availability can change between refreshes, so confirm with the shop before purchasing.

For newly added shops, the app checks whether the site exposes Shopify's public product-search format. If it does, the shop is marked as live-connected and searches use its public listings, product pages, images, variant prices, and availability. Shopify search suggestions return at most 10 matches, so the cheapest result may be missed when a card has many printings; exact stock counts are not public. If the app cannot verify the format, it adds the shop as manual-search only. Other storefront types need their own connector.

The app checks available printings/variants first, sorts them by price, and shows the cheapest in that shop's column. Use **Remove printing** to hide that choice for the current results and show the next cheapest; a new search resets those temporary removals. If none are available, the cheapest out-of-stock printing/variant is shown instead.

The local helper uses Node.js and only built-in Node modules. It runs on this computer and costs nothing to host. Card Kingdom's direct feed is undocumented and may sometimes be unavailable; when it cannot be reached, the app uses the Card Kingdom price that Archidekt includes in the collection data. Sabai's public catalog page may change its layout, enforce traffic limits, or block automated requests; if that happens, the app reports a lookup error and the shop can still be opened manually from its link. Hobby Bugong's API is publicly accessible today but its route and response format may change; the app reports a lookup error if that happens. Other shops without live connections open a domain-limited web search instead.

The app itself has no hosting cost when used this way. Scryfall serves the card lookups and images; use it at a modest personal pace and follow its [API rate guidance](https://scryfall.com/docs/faqs/i-m-having-trouble-accessing-the-scryfall-api-or-im-blocked-17). No cloud backup is provided, so clearing browser data or switching devices can remove the locally saved wishlist and shop list.

## Optional: host online for free with Render

The project is prepared for Render: `package.json` starts the Node helper, and `server.js` uses Render's assigned port while keeping local use bound to this computer.

1. Create a GitHub repository and upload the files inside this app folder: `index.html`, `server.js`, and `package.json` (you may include `README.md` too).
2. In Render, choose **New → Web Service**, connect the GitHub repository, and choose the branch containing the app.
3. Choose **Node** as the runtime. If the app files are inside a subfolder of the repository, set **Root Directory** to that folder (for example, `mtg-price-finder`).
4. Enter `npm install` for **Build Command**, `npm start` for **Start Command**, and choose the **Free** instance type.
5. Click **Deploy Web Service**. When deployment finishes, open the `onrender.com` address Render gives you.

Render free web services sleep after 15 minutes without incoming traffic, so the first visit afterward may take a little time to wake up. The app keeps wishlist and shop settings in each browser's local storage; these do not sync between devices or between the local file and the online address. The online address is public to anyone who has the link, even if the GitHub repository is private. See [Render's free service limits](https://render.com/docs/free) and [Node web service setup](https://render.com/docs/web-services).
