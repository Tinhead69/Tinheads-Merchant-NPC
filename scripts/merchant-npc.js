const MODULE_ID = "merchant-npc";
const CURRENCY = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
const FLOAT_PRESETS = [["Poor", 200], ["Average", 500], ["Rich", 1000]];
const SHOP_TYPES = { general: "Standard Merchant", jeweller: "Jeweller" };
const ITEM_CATEGORIES = [
  ["potions", "Potions"], ["weapons", "Weapons"], ["armour", "Armour"],
  ["magic", "Magic Items"], ["equipment", "Normal Equipment"]
];
const pendingPurchases = new Map();

function priceLabel(price = {}) { return `${price.value ?? price.amount ?? 0} ${price.denomination ?? price.currency ?? "gp"}`; }
function isItemDocument(document) { return document?.documentName === "Item"; }
function isConfiguredShop(actor) { return Boolean(actor?.type === "npc" && (actor.getFlag(MODULE_ID, "isShop") || (actor.getFlag(MODULE_ID, "stock") ?? []).length)); }
function stripHTML(value = "") { const template = document.createElement("template"); template.innerHTML = String(value); return (template.content.textContent ?? "").trim(); }
function classifyItem(item) {
  const system = item.system ?? {};
  const subtype = String(system.type?.value ?? system.type ?? system.consumableType ?? "").toLowerCase();
  const properties = system.properties instanceof Set ? [...system.properties] : Array.isArray(system.properties) ? system.properties : Object.entries(system.properties ?? {}).filter(([, value]) => Boolean(value)).map(([key]) => key);
  const rarity = String(system.rarity?.value ?? system.rarity ?? "").toLowerCase();
  const attunement = String(system.attunement?.value ?? system.attunement ?? "").toLowerCase();
  const magical = Boolean(system.magical || (rarity && !["none", "mundane"].includes(rarity)) || (attunement && attunement !== "none") || properties.some(value => String(value).toLowerCase() === "mgc"));
  const armour = item.type === "equipment" && Boolean(system.armor || ["light", "medium", "heavy", "shield"].includes(subtype));
  const potion = item.type === "consumable" && (subtype.includes("potion") || String(system.identifier ?? "").toLowerCase().includes("potion"));
  // Specific physical categories take priority over magical status.
  if (item.type === "weapon") return "weapons";
  if (armour) return "armour";
  if (potion) return "potions";
  if (magical) return "magic";
  if (["equipment", "tool", "loot", "container"].includes(item.type)) return "equipment";
  return null;
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "randomCount", { name: "Random stock count", hint: "Default number of items added by random compendium generation.", scope: "world", config: true, type: Number, default: 10, range: { min: 1, max: 100, step: 1 } });
});

Hooks.once("ready", () => {
  game.merchantNPC = { open: async (actor) => {
    if (game.user.isGM) await actor.setFlag(MODULE_ID, "isShop", true);
    return new MerchantSheet(actor).render(true);
  } };
  game.socket.on(`module.${MODULE_ID}`, async message => {
    if (message?.kind === "purchase-result" && message.userId === game.user.id) {
      const resolve = pendingPurchases.get(message.requestId);
      if (resolve) { pendingPurchases.delete(message.requestId); resolve(message); }
      return;
    }
    if (message?.kind !== "purchase-request") return;
    const activeGM = game.users.find(user => user.isGM && user.active);
    if (!game.user.isGM || activeGM?.id !== game.user.id) return;
    const result = await processPurchase(message);
    game.socket.emit(`module.${MODULE_ID}`, { kind: "purchase-result", requestId: message.requestId, userId: message.userId, ...result });
  });
  Hooks.on("getActorDirectoryEntryContext", (_html, entries) => entries.push({
    name: "Open Merchant Shop", icon: '<i class="fas fa-store"></i>',
    condition: (li) => isConfiguredShop(game.actors.get(li.data("documentId"))),
    callback: (li) => game.merchantNPC.open(game.actors.get(li.data("documentId")))
  }));
  // Directory double-click works even when Foundry blocks opening the actor sheet for a player.
  Hooks.on("renderActorDirectory", (app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || root.dataset.merchantDoubleClickBound) return;
    root.dataset.merchantDoubleClickBound = "true";
    root.addEventListener("dblclick", event => {
      const row = event.target.closest(".directory-item[data-document-id]");
      const actor = row && game.actors.get(row.dataset.documentId);
      if (!isConfiguredShop(actor) || game.user.isGM || actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      game.merchantNPC.open(actor);
    }, true);
  });
  // Token HUD gives players without actor-sheet permission a reliable canvas entry point.
  Hooks.on("renderTokenHUD", (hud, html) => {
    const actor = hud.object?.actor ?? hud.document?.actor;
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || !isConfiguredShop(actor) || game.user.isGM || actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER) || root.querySelector(".merchant-token-shop")) return;
    const button = document.createElement("div");
    button.className = "control-icon merchant-token-shop";
    button.dataset.tooltip = "Open Merchant Shop";
    button.innerHTML = '<i class="fas fa-store"></i>';
    button.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); game.merchantNPC.open(actor); });
    (root.querySelector(".col.right") ?? root.querySelector(".col.left") ?? root).append(button);
  });
  const addMerchantButton = (app, html) => {
    const actor = app.actor ?? app.document;
    if (actor?.type !== "npc") return;
    const configuredShop = actor.getFlag(MODULE_ID, "isShop") || (actor.getFlag(MODULE_ID, "stock") ?? []).length > 0;
    const canViewActor = actor.testUserPermission(game.user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER);
    if (!game.user.isGM && configuredShop && !canViewActor) {
      Promise.resolve(app.close()).then(() => game.merchantNPC.open(actor));
      return;
    }
    const root = html instanceof HTMLElement ? html : html?.[0];
    const header = root?.querySelector(".window-header");
    if (!header || header.querySelector(".merchant-open")) return;
    const button = document.createElement("a");
    button.className = "header-control merchant-open";
    button.innerHTML = '<i class="fas fa-store"></i> Shop';
    button.title = "Open merchant shop";
    button.addEventListener("click", (event) => { event.preventDefault(); game.merchantNPC.open(actor); });
    header.insertBefore(button, header.querySelector(".window-controls") ?? null);
  };
  Hooks.on("renderActorSheetV2", addMerchantButton);
  Hooks.on("renderActorSheet", addMerchantButton);
});

function copperValue(currency = {}) { return Object.entries(CURRENCY).reduce((total, [key, value]) => total + Number(currency[key] ?? 0) * value, 0); }
function currencyFromCopper(amount) {
  let remaining = Math.max(0, Math.round(amount)); const result = {};
  for (const [key, value] of Object.entries(CURRENCY)) { result[key] = Math.floor(remaining / value); remaining %= value; }
  return result;
}
async function processPurchase({ actorId, buyerId, stockId, userId }) {
  const merchant = game.actors.get(actorId), buyer = game.actors.get(buyerId), requestingUser = game.users.get(userId);
  if (!merchant || !buyer || !requestingUser || (!requestingUser.isGM && requestingUser.character?.id !== buyer.id)) return { success: false, message: "The selected buyer is not assigned to your user." };
  if (!requestingUser.isGM && !buyer.testUserPermission(requestingUser, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) return { success: false, message: "You do not own that character." };
  const stock = foundry.utils.deepClone(merchant.getFlag(MODULE_ID, "stock") ?? []), entry = stock.find(item => item.id === stockId);
  if (!entry || Number(entry.quantity) < 1) return { success: false, message: "That item is out of stock." };
  const price = entry.system?.price ?? {}, denomination = String(price.denomination ?? "gp").toLowerCase(), coinValue = CURRENCY[denomination];
  const cost = Math.round(Number(price.value ?? price.amount ?? 0) * coinValue);
  if (!Number.isFinite(cost) || cost < 0) return { success: false, message: "This item has an invalid price." };
  const buyerCurrency = buyer.system.currency ?? {}, merchantCurrency = merchant.system.currency ?? {};
  if (copperValue(buyerCurrency) < cost) return { success: false, message: "You do not have enough money." };
  try {
    const sourceItem = entry.sourceUuid ? await fromUuid(entry.sourceUuid) : null;
    const itemData = sourceItem?.toObject?.() ?? { name: entry.name, type: entry.type, img: entry.img, system: foundry.utils.deepClone(entry.system ?? {}) };
    delete itemData._id;
    await buyer.createEmbeddedDocuments("Item", [itemData]);
    await buyer.update({ "system.currency": currencyFromCopper(copperValue(buyerCurrency) - cost) });
    await merchant.update({ "system.currency": currencyFromCopper(copperValue(merchantCurrency) + cost) });
    entry.quantity = Number(entry.quantity) - 1; await merchant.setFlag(MODULE_ID, "stock", stock);
    return { success: true, message: `Purchased ${entry.name} for ${priceLabel(price)}.` };
  } catch (error) { console.error(`${MODULE_ID} | Purchase failed`, error); return { success: false, message: "The purchase failed while updating the actors." }; }
}
function requestPurchase(actorId, buyerId, stockId) {
  return new Promise(resolve => {
    const requestId = foundry.utils.randomID(); pendingPurchases.set(requestId, resolve);
    game.socket.emit(`module.${MODULE_ID}`, { kind: "purchase-request", requestId, actorId, buyerId, stockId, userId: game.user.id });
    window.setTimeout(() => { if (pendingPurchases.has(requestId)) { pendingPurchases.delete(requestId); resolve({ success: false, message: "The GM did not respond to the purchase request." }); } }, 15000);
  });
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class MerchantSheet extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options = {}) {
    super({ ...options, id: `merchant-npc-${actor.id}` });
    this.actor = actor;
    this.shopType = actor.getFlag(MODULE_ID, "shopType") ?? "general";
  }
  static DEFAULT_OPTIONS = {
    id: "merchant-npc", tag: "form", classes: ["merchant-npc"], window: { title: "Merchant Shop", resizable: true }, position: { width: 1000, height: 720 },
    form: { handler: MerchantSheet.#onSubmit, submitOnChange: false },
    actions: { addItems: MerchantSheet.#addItems, removeItem: MerchantSheet.#removeItem, saveItem: MerchantSheet.#saveItem, buy: MerchantSheet.#buy, setFloat: MerchantSheet.#setFloat, setShopType: MerchantSheet.#setShopType }
  };
  static PARTS = { form: { template: "modules/merchant-npc/templates/merchant-sheet.hbs" } };
  get title() { return `${this.actor.name} — ${SHOP_TYPES[this.shopType] ?? SHOP_TYPES.general}`; }
  async _prepareContext() {
    const stock = this.actor.getFlag(MODULE_ID, "stock") ?? [];
    return {
      actor: this.actor,
      stock: stock.map(item => {
        const price = item.system?.price;
        const hasPrice = price?.value !== undefined && price?.value !== null && price?.value !== "";
        return { ...item, hasPrice, priceMissing: !hasPrice, priceText: hasPrice ? priceLabel(price) : "Price not set", denomination: price?.denomination ?? "gp" };
      }),
      isGM: game.user.isGM,
      shopTypeLabel: SHOP_TYPES[this.shopType] ?? SHOP_TYPES.general,
      shopType: this.shopType,
      shopTypeOptions: Object.entries(SHOP_TYPES).map(([value, label]) => ({ value, label, selected: value === this.shopType })),
      funds: this.#funds(),
      floatPresets: FLOAT_PRESETS.map(([name, amount]) => {
        const value = amount * (this.shopType === "jeweller" ? 10 : 1);
        return { value, label: `${name} · ${value.toLocaleString()} gp` };
      }),
      floatHint: this.shopType === "jeweller" ? "Jeweller float presets are ten times the normal NPC amounts." : "Choose a starting purse in gold pieces."
    };
  }
  #funds() { const c = this.actor.system.currency ?? {}; return Object.entries(CURRENCY).map(([k]) => `${k}: ${Number(c[k] ?? 0)}`).join(" · "); }
  static async #onSubmit() {}
  static async #addItems() { new ItemBrowser(this.actor, this).render(true); }
  async addStock(source, quantity = 1) {
    const stock = foundry.utils.deepClone(this.actor.getFlag(MODULE_ID, "stock") ?? []);
    const sourceUuid = source._stats?.compendiumSource ?? source.uuid ?? (source._id ? `Item.${source._id}` : `${source.type}:${source.name}`);
    const existing = stock.find(item => item.sourceUuid === sourceUuid || (!item.sourceUuid && item.name === source.name && item.type === source.type));
    if (existing) existing.quantity = Number(existing.quantity ?? 0) + quantity;
    else stock.push({ id: foundry.utils.randomID(), name: source.name, img: source.img ?? "icons/svg/item-bag.svg", type: source.type, system: foundry.utils.deepClone(source.system ?? {}), sourceUuid, quantity });
    await this.actor.setFlag(MODULE_ID, "stock", stock);
    await this.actor.setFlag(MODULE_ID, "isShop", true);
    this.render();
  }
  static async #removeItem(_event, target) {
    const stock = (this.actor.getFlag(MODULE_ID, "stock") ?? []).filter(item => item.id !== target.dataset.id);
    await this.actor.setFlag(MODULE_ID, "stock", stock);
    this.render();
  }
  static async #saveItem(_event, target) {
    const row = target.closest("[data-stock-id]");
    const id = row?.dataset.stockId;
    const stock = foundry.utils.deepClone(this.actor.getFlag(MODULE_ID, "stock") ?? []);
    const item = stock.find(entry => entry.id === id);
    if (!item || !row) return;
    item.quantity = Math.max(0, Number(row.querySelector("[name='quantity']")?.value ?? 0));
    item.system.price ??= {};
    item.system.price.value = Math.max(0, Number(row.querySelector("[name='price']")?.value ?? 0));
    item.system.price.denomination ??= item.system.price.currency ?? "gp";
    await this.actor.setFlag(MODULE_ID, "stock", stock);
    this.render();
  }
  static async #setFloat() {
    if (!game.user.isGM) return ui.notifications.error("Only the GM can set a merchant's starting float.");
    const preset = this.element.querySelector("[name='floatPreset']")?.value;
    const custom = Number(this.element.querySelector("[name='floatAmount']")?.value);
    const gp = preset === "custom" ? custom : Number(preset);
    if (!Number.isFinite(gp) || gp < 0) return ui.notifications.warn("Enter a valid non-negative amount of gold pieces.");
    let balance = Math.round(gp * CURRENCY.gp);
    const currency = {};
    for (const [denomination, value] of Object.entries(CURRENCY)) { currency[denomination] = Math.floor(balance / value); balance %= value; }
    await this.actor.update({ "system.currency": currency });
    await this.actor.setFlag(MODULE_ID, "isShop", true);
    this.render();
  }
  static async #setShopType() {
    const type = this.element.querySelector("[name='shopType']")?.value ?? "general";
    await this.actor.setFlag(MODULE_ID, "shopType", SHOP_TYPES[type] ? type : "general");
    await this.actor.setFlag(MODULE_ID, "isShop", true);
    this.shopType = type;
    this.render();
  }
  static async #buy(_event, target) {
    const buyer = game.user.character;
    if (!buyer) return ui.notifications.warn("Assign your user a character in User Configuration before purchasing.");
    const result = game.user.isGM
      ? await processPurchase({ actorId: this.actor.id, buyerId: buyer.id, stockId: target.dataset.id, userId: game.user.id })
      : await requestPurchase(this.actor.id, buyer.id, target.dataset.id);
    if (!result?.success) return ui.notifications.warn(result?.message ?? "The purchase could not be completed.");
    ui.notifications.info(result.message ?? "Purchase completed.");
    this.render();
  }
  _onDrop(event) {
    const data = TextEditor.getDragEventData(event);
    if (data?.type !== "Item") return super._onDrop?.(event);
    event.preventDefault();
    fromUuid(data.uuid).then(item => item && this.addStock(item.toObject()));
  }
}

class ItemBrowser extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, merchantSheet, options = {}) {
    super({ ...options, id: `merchant-item-browser-${actor.id}` });
    this.actor = actor;
    this.merchantSheet = merchantSheet;
    this.catalog = null;
    this.selectedTypes = new Set();
    this.selectedSources = null;
    this.search = "";
    this.visibleItems = [];
  }
  static DEFAULT_OPTIONS = {
    id: "merchant-item-browser", tag: "form", classes: ["merchant-item-browser"], window: { title: "Add Items to Shop", resizable: true }, position: { width: 1050, height: 720 },
    form: { handler: ItemBrowser.#onSubmit, submitOnChange: false },
    actions: { applyFilters: ItemBrowser.#applyFilters, addItem: ItemBrowser.#addItem, randomItems: ItemBrowser.#randomItems, rollTable: ItemBrowser.#rollTable, done: ItemBrowser.#done }
  };
  static PARTS = { form: { template: "modules/merchant-npc/templates/item-browser.hbs" } };
  _onRender(context, options) {
    super._onRender?.(context, options);
    for (const checkbox of this.element.querySelectorAll("[name='itemSource']")) checkbox.addEventListener("change", () => {
      this.selectedSources = new Set([...this.element.querySelectorAll("[name='itemSource']:checked")].map(input => input.value));
      this.search = this.element.querySelector("[name='itemSearch']")?.value ?? "";
      this.render();
    });
  }
  async #loadCatalog() {
    if (this.catalog) return this.catalog;
    if (this.catalogPromise) return this.catalogPromise;
    const loadingDialog = document.createElement("dialog");
    loadingDialog.className = "merchant-loading-dialog";
    loadingDialog.textContent = "Compendiums loading, please wait";
    document.body.append(loadingDialog);
    try { loadingDialog.showModal(); } catch { loadingDialog.setAttribute("open", ""); }
    this.catalogPromise = (async () => {
      const sources = [];
      const worldItems = game.items.contents.map(item => ({ _id: item.id, name: item.name, img: item.img, type: item.type, category: classifyItem(item), description: stripHTML(item.system?.description?.value ?? item.system?.description ?? ""), source: "world-items" })).filter(item => item.category);
      if (worldItems.length) sources.push({ id: "world-items", label: "World Items", items: worldItems, world: true });
      for (const pack of game.packs.filter(candidate => candidate.documentName === "Item")) {
        await pack.getIndex({ fields: ["system.type.value", "system.armor", "system.rarity", "system.attunement", "system.properties", "system.magical", "system.identifier", "system.description.value", "system.description"] });
        const items = [...pack.index].map(entry => ({ _id: entry._id, name: entry.name, img: entry.img, type: entry.type, category: classifyItem(entry), description: stripHTML(entry.system?.description?.value ?? entry.system?.description ?? ""), source: pack.collection })).filter(item => item.category);
        if (items.length) sources.push({ id: pack.collection, label: pack.title, items, world: false });
      }
      sources.sort((a, b) => a.label.localeCompare(b.label));
      this.catalog = sources;
      return sources;
    })();
    try { return await this.catalogPromise; }
    finally { if (loadingDialog.open) loadingDialog.close(); loadingDialog.remove(); this.catalogPromise = null; }
  }
  async _prepareContext() {
    const sources = await this.#loadCatalog();
    const typeOptions = ITEM_CATEGORIES.map(([value, label]) => ({ value, label, checked: this.selectedTypes.has(value) }));
    const matchingSources = sources.filter(source => source.items.some(item => this.selectedTypes.has(item.category)));
    this.selectedSources ??= new Set(matchingSources.map(source => source.id));
    this.selectedSources = new Set([...this.selectedSources].filter(id => matchingSources.some(source => source.id === id)));
    const sourceOptions = matchingSources.map(source => ({ id: source.id, label: source.label, count: source.items.filter(item => this.selectedTypes.has(item.category)).length, checked: this.selectedSources.has(source.id) }));
    const query = this.search.trim().toLowerCase();
    this.visibleItems = matchingSources.filter(source => this.selectedSources.has(source.id)).flatMap(source => source.items
      .filter(item => this.selectedTypes.has(item.category) && (!query || item.name.toLowerCase().includes(query)))
      .map(item => ({ ...item, typeLabel: ITEM_CATEGORIES.find(([value]) => value === item.category)?.[1] ?? item.type, sourceLabel: sources.find(source => source.id === item.source)?.label ?? item.source })))
      .sort((a, b) => a.name.localeCompare(b.name));
    const tables = await getRollTables(this.selectedTypes);
    return { actor: this.actor, types: typeOptions, sources: sourceOptions, items: this.visibleItems, tables, search: this.search, randomCount: game.settings.get(MODULE_ID, "randomCount"), isGM: game.user.isGM };
  }
  static async #onSubmit() {}
  static async #applyFilters() {
    this.selectedTypes = new Set([...this.element.querySelectorAll("[name='itemType']:checked")].map(input => input.value));
    this.selectedSources = new Set([...this.element.querySelectorAll("[name='itemSource']:checked")].map(input => input.value));
    this.search = this.element.querySelector("[name='itemSearch']")?.value ?? "";
    this.render();
  }
  async #resolveItem(sourceId, itemId) {
    if (sourceId === "world-items") return game.items.get(itemId);
    return game.packs.get(sourceId)?.getDocument(itemId);
  }
  static async #addItem(_event, target) {
    const item = await this.#resolveItem(target.dataset.source, target.dataset.item);
    if (!item) return ui.notifications.warn("Could not load that item.");
    await this.merchantSheet.addStock(item.toObject());
    ui.notifications.info(`${item.name} added to ${this.actor.name}'s shop.`);
  }
  static async #randomItems() {
    const count = Math.max(1, Number(this.element.querySelector("[name='randomCount']")?.value ?? game.settings.get(MODULE_ID, "randomCount")));
    const shuffled = [...this.visibleItems];
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    const selected = shuffled.slice(0, count);
    for (const record of selected) {
      const item = await this.#resolveItem(record.source, record._id);
      if (item) await this.merchantSheet.addStock(item.toObject());
    }
    if (!selected.length) ui.notifications.warn("No items match the selected item types and compendiums.");
    else ui.notifications.info(`Added ${selected.length} random item${selected.length === 1 ? "" : "s"} to the shop.`);
  }
  static async #rollTable() {
    const uuid = this.element.querySelector("[name='rollTableUuid']")?.value;
    const draws = Math.max(1, Math.min(100, Number(this.element.querySelector("[name='tableDraws']")?.value ?? 1)));
    const table = uuid && await fromUuid(uuid);
    if (!table) return ui.notifications.warn("Choose a rollable table first.");
    let added = 0;
    for (let i = 0; i < draws; i++) {
      const draw = await table.draw({ displayChat: false, recursive: true });
      for (const result of draw.results ?? []) {
        let item;
        try { item = await result.getDocument?.(); } catch { /* Try the result UUID below. */ }
        if (!isItemDocument(item) && result.documentUuid) {
          try { item = await fromUuid(result.documentUuid); } catch { /* Ignore non-item table results. */ }
        }
        if (!isItemDocument(item) && result.documentCollection && result.documentId) {
          if (result.documentCollection === "world.items") item = game.items.get(result.documentId);
          else {
            const uuid = result.documentCollection.startsWith("Compendium.") ? `${result.documentCollection}.${result.documentId}` : `Compendium.${result.documentCollection}.${result.documentId}`;
            try { item = await fromUuid(uuid); } catch { /* Ignore non-item table results. */ }
          }
        }
        if (isItemDocument(item) && this.selectedTypes.has(classifyItem(item))) { await this.merchantSheet.addStock(item.toObject()); added++; }
      }
    }
    if (added) ui.notifications.info(`Added ${added} item result${added === 1 ? "" : "s"} from ${table.name}.`);
    else ui.notifications.warn("The selected table returned no linked Item documents. Link its results to Item documents to stock them automatically.");
  }
  static async #done() { this.close(); }
}

async function getRollTables(selectedTypes = new Set()) {
  if (!selectedTypes.size) return [];
  const tables = [];
  const addIfMatching = async (table, source) => {
    const matching = await Promise.all([...table.results].map(async result => {
      let item;
      try { item = await result.getDocument?.(); } catch { /* Check document UUID fields next. */ }
      if (!isItemDocument(item) && result.documentUuid) {
        try { item = await fromUuid(result.documentUuid); } catch { /* Ignore unavailable result documents. */ }
      }
      if (!isItemDocument(item) && result.documentCollection && result.documentId) {
        const uuid = result.documentCollection === "world.items" ? `Item.${result.documentId}` : `${result.documentCollection.startsWith("Compendium.") ? "" : "Compendium."}${result.documentCollection}.${result.documentId}`;
        try { item = await fromUuid(uuid); } catch { /* Ignore non-item table results. */ }
      }
      return isItemDocument(item) && selectedTypes.has(classifyItem(item));
    }));
    if (matching.some(Boolean)) tables.push({ uuid: table.uuid, name: table.name, source });
  };
  for (const table of game.tables.contents) await addIfMatching(table, "World Tables");
  for (const pack of game.packs.filter(candidate => candidate.documentName === "RollTable")) {
    await pack.getIndex();
    for (const entry of pack.index) {
      const table = await pack.getDocument(entry._id);
      if (table) await addIfMatching(table, pack.title);
    }
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name));
}
