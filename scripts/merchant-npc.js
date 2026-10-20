const MODULE_ID = "merchant-npc";
const CURRENCY = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
const FLOAT_PRESETS = [["Poor", 200], ["Average", 500], ["Rich", 1000]];
const SHOP_TYPES = { general: "General Goods", equipment: "Equipment", weapons: "Weapons", armour: "Armour", potions: "Potions", magic: "Magic Items", jeweller: "Jeweller" };
const ITEM_TYPE_LABELS = { weapon: "Weapons", equipment: "Equipment", consumable: "Consumables", tool: "Tools", loot: "Loot", spell: "Spells", container: "Containers", feat: "Features", class: "Classes", subclass: "Subclasses", background: "Backgrounds", race: "Races", species: "Species" };

function priceLabel(price = {}) { return `${price.value ?? price.amount ?? 0} ${price.denomination ?? price.currency ?? "gp"}`; }
function isItemDocument(document) { return document?.documentName === "Item"; }

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "randomCount", { name: "Random stock count", hint: "Default number of items added by random compendium generation.", scope: "world", config: true, type: Number, default: 10, range: { min: 1, max: 100, step: 1 } });
});

Hooks.once("ready", () => {
  game.merchantNPC = { open: async (actor) => {
    const type = await foundry.applications.api.DialogV2.prompt({
      window: { title: `Choose ${actor.name}'s shop type` },
      content: `<label class="merchant-shop-type-prompt">Shop type<select name="shopType">${Object.entries(SHOP_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>`,
      rejectClose: false,
      ok: { label: "Open Shop", callback: (_event, button) => button.form.elements.shopType.value }
    });
    if (type) new MerchantSheet(actor, { shopType: type }).render(true);
  } };
  Hooks.on("getActorDirectoryEntryContext", (_html, entries) => entries.push({
    name: "Open Merchant Shop", icon: '<i class="fas fa-store"></i>',
    condition: (li) => game.actors.get(li.data("documentId"))?.type === "npc",
    callback: (li) => game.merchantNPC.open(game.actors.get(li.data("documentId")))
  }));
  const addMerchantButton = (app, html) => {
    const actor = app.actor ?? app.document;
    if (actor?.type !== "npc") return;
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

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class MerchantSheet extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options = {}) {
    super({ ...options, id: `merchant-npc-${actor.id}` });
    this.actor = actor;
    this.shopType = options.shopType ?? "general";
  }
  static DEFAULT_OPTIONS = {
    id: "merchant-npc", tag: "form", classes: ["merchant-npc"], window: { title: "Merchant Shop", resizable: true }, position: { width: 760, height: 720 },
    form: { handler: MerchantSheet.#onSubmit, submitOnChange: false },
    actions: { addItems: MerchantSheet.#addItems, removeItem: MerchantSheet.#removeItem, saveItem: MerchantSheet.#saveItem, buy: MerchantSheet.#buy, setFloat: MerchantSheet.#setFloat }
  };
  static PARTS = { form: { template: "modules/merchant-npc/templates/merchant-sheet.hbs" } };
  get title() { return `${this.actor.name} — ${SHOP_TYPES[this.shopType] ?? SHOP_TYPES.general}`; }
  async _prepareContext() {
    const stock = this.actor.getFlag(MODULE_ID, "stock") ?? [];
    return {
      actor: this.actor,
      stock: stock.map(item => ({ ...item, priceText: priceLabel(item.system?.price) })),
      isGM: game.user.isGM,
      shopTypeLabel: SHOP_TYPES[this.shopType] ?? SHOP_TYPES.general,
      buyers: game.actors.filter(actor => actor.type === "character" && (game.user.isGM || actor.isOwner)),
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
    const sourceUuid = source._stats?.compendiumSource ?? source.uuid ?? "";
    const existing = stock.find(item => sourceUuid && item.sourceUuid === sourceUuid);
    if (existing) existing.quantity = Number(existing.quantity ?? 0) + quantity;
    else stock.push({ id: foundry.utils.randomID(), name: source.name, img: source.img ?? "icons/svg/item-bag.svg", type: source.type, system: foundry.utils.deepClone(source.system ?? {}), sourceUuid, quantity });
    await this.actor.setFlag(MODULE_ID, "stock", stock);
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
    item.system.price.denomination = row.querySelector("[name='denomination']")?.value ?? "gp";
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
    this.render();
  }
  static async #buy(_event, target) {
    const stock = foundry.utils.deepClone(this.actor.getFlag(MODULE_ID, "stock") ?? []);
    const item = stock.find(entry => entry.id === target.dataset.id);
    if (!item) return ui.notifications.warn("This item is no longer in stock.");
    const buyer = game.actors.get(this.element.querySelector("[name='buyer']")?.value);
    if (!buyer) return ui.notifications.warn("Choose a buyer first.");
    if (!game.user.isGM && !buyer.isOwner) return ui.notifications.error("You can only purchase for a character you own.");
    const price = item.system?.price ?? {};
    const denomination = price.denomination ?? price.currency ?? "gp";
    const value = Number(price.value ?? price.amount ?? 0);
    if (!(value > 0) || !CURRENCY[denomination]) return ui.notifications.warn("Set a valid item price before selling it.");
    const copper = Math.ceil(value * CURRENCY[denomination]);
    const buyerCurrency = foundry.utils.deepClone(buyer.system.currency ?? {});
    const total = Object.entries(CURRENCY).reduce((sum, [key, factor]) => sum + Number(buyerCurrency[key] ?? 0) * factor, 0);
    if (total < copper) return ui.notifications.warn(`${buyer.name} does not have enough funds.`);
    let remainder = total - copper;
    for (const [key, factor] of Object.entries(CURRENCY)) { buyerCurrency[key] = Math.floor(remainder / factor); remainder %= factor; }
    const merchantCurrency = foundry.utils.deepClone(this.actor.system.currency ?? {});
    let credit = copper;
    for (const [key, factor] of Object.entries(CURRENCY)) { merchantCurrency[key] = Number(merchantCurrency[key] ?? 0) + Math.floor(credit / factor); credit %= factor; }
    const source = { name: item.name, type: item.type, img: item.img, system: foundry.utils.deepClone(item.system) };
    source.system.quantity = Number(source.system.quantity ?? 1);
    await buyer.createEmbeddedDocuments("Item", [source]);
    await buyer.update({ "system.currency": buyerCurrency });
    await this.actor.update({ "system.currency": merchantCurrency });
    item.quantity = Number(item.quantity ?? 1) - 1;
    if (item.quantity <= 0) stock.splice(stock.indexOf(item), 1);
    await this.actor.setFlag(MODULE_ID, "stock", stock);
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
    this.selectedTypes = null;
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
  async #loadCatalog() {
    if (this.catalog) return this.catalog;
    const sources = [];
    const worldItems = game.items.contents.map(item => ({ _id: item.id, name: item.name, img: item.img, type: item.type, item, source: "world-items" }));
    if (worldItems.length) sources.push({ id: "world-items", label: "World Items", items: worldItems, world: true });
    for (const pack of game.packs.filter(candidate => candidate.documentName === "Item")) {
      await pack.getIndex();
      const items = [...pack.index].map(entry => ({ _id: entry._id, name: entry.name, img: entry.img, type: entry.type, source: pack.collection }));
      if (items.length) sources.push({ id: pack.collection, label: pack.title, items, world: false });
    }
    sources.sort((a, b) => a.label.localeCompare(b.label));
    this.catalog = sources;
    return sources;
  }
  async _prepareContext() {
    const sources = await this.#loadCatalog();
    const allTypes = [...new Set(sources.flatMap(source => source.items.map(item => item.type).filter(Boolean)))].sort();
    this.selectedTypes ??= new Set(allTypes);
    const matchingSources = sources.filter(source => source.items.some(item => this.selectedTypes.has(item.type)));
    this.selectedSources ??= new Set(matchingSources.map(source => source.id));
    this.selectedSources = new Set([...this.selectedSources].filter(id => matchingSources.some(source => source.id === id)));
    const typeOptions = allTypes.map(value => ({ value, label: ITEM_TYPE_LABELS[value] ?? value[0].toUpperCase() + value.slice(1), checked: this.selectedTypes.has(value) }));
    const sourceOptions = matchingSources.map(source => ({ id: source.id, label: source.label, count: source.items.filter(item => this.selectedTypes.has(item.type)).length, checked: this.selectedSources.has(source.id) }));
    const query = this.search.trim().toLowerCase();
    this.visibleItems = matchingSources.filter(source => this.selectedSources.has(source.id)).flatMap(source => source.items
      .filter(item => this.selectedTypes.has(item.type) && (!query || item.name.toLowerCase().includes(query)))
      .map(item => ({ ...item, typeLabel: ITEM_TYPE_LABELS[item.type] ?? item.type, sourceLabel: sources.find(source => source.id === item.source)?.label ?? item.source })))
      .sort((a, b) => a.name.localeCompare(b.name));
    const tables = await getRollTables();
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
        if (isItemDocument(item)) { await this.merchantSheet.addStock(item.toObject()); added++; }
      }
    }
    if (added) ui.notifications.info(`Added ${added} item result${added === 1 ? "" : "s"} from ${table.name}.`);
    else ui.notifications.warn("The selected table returned no linked Item documents. Link its results to Item documents to stock them automatically.");
  }
  static async #done() { this.close(); }
}

async function getRollTables() {
  const tables = game.tables.contents.map(table => ({ uuid: table.uuid, name: table.name, source: "World Tables" }));
  for (const pack of game.packs.filter(candidate => candidate.documentName === "RollTable")) {
    await pack.getIndex();
    for (const entry of pack.index) tables.push({ uuid: entry.uuid ?? `Compendium.${pack.collection}.${entry._id}`, name: entry.name, source: pack.title });
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name));
}
