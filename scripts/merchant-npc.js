const MODULE_ID = "merchant-npc";
const CURRENCY = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
const FLOAT_PRESETS = [ ["poor", "Poor", 200], ["average", "Average", 500], ["rich", "Rich", 1000] ];
const SHOP_TYPES = {
  general: "General Goods", equipment: "Equipment", weapons: "Weapons",
  armour: "Armour", potions: "Potions", magic: "Magic Items", jeweller: "Jeweller"
};

function itemMatchesShop(item, shopType) {
  const system = item.system ?? {};
  const subtype = String(system.type?.value ?? system.type ?? system.consumableType ?? "").toLowerCase();
  if (shopType === "general") return true;
  if (shopType === "equipment") return ["equipment", "tool"].includes(item.type);
  if (shopType === "weapons") return item.type === "weapon";
  if (shopType === "armour") return item.type === "equipment" && Boolean(system.armor || ["light", "medium", "heavy", "shield"].includes(subtype));
  if (shopType === "potions") return item.type === "consumable" && (subtype.includes("potion") || String(system.identifier ?? "").toLowerCase().includes("potion"));
  if (shopType === "jeweller") {
    const jewelryText = `${item.name ?? ""} ${subtype} ${system.identifier ?? ""}`.toLowerCase();
    return item.type === "loot" || item.type === "equipment" && /jewel|jewelry|jewellery|gem|ring|necklace|amulet|crown|brooch/.test(jewelryText);
  }
  if (shopType === "magic") {
    const rarity = String(system.rarity?.value ?? system.rarity ?? "").toLowerCase();
    const attunement = String(system.attunement?.value ?? system.attunement ?? "").toLowerCase();
    const properties = system.properties instanceof Set ? [...system.properties] : Array.isArray(system.properties) ? system.properties : Object.keys(system.properties ?? {});
    return Boolean(rarity && !["none", "mundane"].includes(rarity)) || Boolean(attunement && attunement !== "none") || properties.some(p => String(p).toLowerCase() === "mgc");
  }
  return true;
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "randomCount", { name: "Random stock count", hint: "Number of items added when generating stock.", scope: "world", config: true, type: Number, default: 10, range: { min: 1, max: 100, step: 1 } });
});

Hooks.once("ready", () => {
  game.merchantNPC = { open: async (actor) => {
    const type = await foundry.applications.api.DialogV2.prompt({
      window: { title: `Choose ${actor.name}'s shop type` },
      content: `<label class="merchant-shop-type-prompt">Shop type<select name="shopType">${Object.entries(SHOP_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}</select></label>`,
      rejectClose: false,
      ok: { label: "Open Shop", callback: (_event, button) => button.form.elements.shopType.value }
    });
    if (!type) return;
    new MerchantSheet(actor, { shopType: type }).render(true);
  } };
  Hooks.on("getActorDirectoryEntryContext", (_html, entries) => {
    entries.push({
      name: "Open Merchant Shop", icon: '<i class="fas fa-store"></i>',
      condition: (li) => game.actors.get(li.data("documentId"))?.type === "npc",
      callback: (li) => game.merchantNPC.open(game.actors.get(li.data("documentId")))
    });
  });
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
  // D&D 5e on Foundry v13 renders ActorSheetV2, which dispatches this V2 hook.
  Hooks.on("renderActorSheetV2", addMerchantButton);
  // Keep support for systems or sheet modules still using the legacy ActorSheet.
  Hooks.on("renderActorSheet", addMerchantButton);
});

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
class MerchantSheet extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options = {}) { super({ ...options, id: `merchant-npc-${actor.id}` }); this.actor = actor; this.shopType = options.shopType ?? "general"; }
  static DEFAULT_OPTIONS = {
    id: "merchant-npc-{id}", tag: "form", classes: ["merchant-npc"], window: { title: "Merchant Shop", resizable: true },
    position: { width: 650, height: 650 }, form: { handler: MerchantSheet.#onSubmit, submitOnChange: false },
    actions: { addWorldItem: MerchantSheet.#addWorldItem, removeItem: MerchantSheet.#removeItem, buy: MerchantSheet.#buy, generate: MerchantSheet.#generate, setFloat: MerchantSheet.#setFloat, refresh: MerchantSheet.#refresh }
  };
  static PARTS = { form: { template: "modules/merchant-npc/templates/merchant-sheet.hbs" } };
  get title() { return `${this.actor.name} — ${SHOP_TYPES[this.shopType] ?? SHOP_TYPES.general}`; }
  async _prepareContext() {
    const stock = (this.actor.getFlag(MODULE_ID, "stock") ?? []).filter(item => itemMatchesShop(item, this.shopType)).map(item => {
      const price = item.system?.price ?? {};
      return { ...item, priceText: `${price.value ?? price.amount ?? 0} ${price.denomination ?? price.currency ?? "gp"}` };
    });
    const packs = [];
    for (const pack of game.packs.filter(p => p.documentName === "Item")) {
      await pack.getIndex();
      if (pack.index.size) packs.push({ collection: pack.collection, label: pack.title, count: pack.index.size });
    }
    packs.sort((a, b) => a.label.localeCompare(b.label));
    return { actor: this.actor, stock, isGM: game.user.isGM,
      packs, shopType: this.shopType, shopTypeLabel: SHOP_TYPES[this.shopType] ?? SHOP_TYPES.general,
      buyers: game.actors.filter(a => a.type === "character" && (game.user.isGM || a.isOwner)), worldItems: game.items.contents.filter(item => itemMatchesShop(item, this.shopType)),
      randomCount: game.settings.get(MODULE_ID, "randomCount"),
      floatPresets: FLOAT_PRESETS.map(([key, label, amount]) => {
        const value = amount * (this.shopType === "jeweller" ? 10 : 1);
        return { value, label: `${label} · ${value.toLocaleString()} gp` };
      }),
      floatHint: this.shopType === "jeweller" ? "Jeweller presets are 10× the normal NPC float." : "Choose a starting purse in gold pieces.",
      funds: this.#funds() };
  }
  #funds() { const c = this.actor.system.currency ?? {}; return Object.entries(CURRENCY).map(([k, v]) => `${k}: ${Number(c[k] ?? 0)}`).join(" · "); }
  static async #onSubmit(event, form, formData) { /* No implicit actor edits; handlers perform explicit actions. */ }
  static async #refresh(_event, _target) { this.render(); }
  static async #addWorldItem(_event, _target) {
    const itemId = this.element.querySelector("[name='worldItem']")?.value;
    const item = game.items.get(itemId); if (item) await this.#addStock(item.toObject());
  }
  async #addStock(source, quantity = 1) {
    if (!itemMatchesShop(source, this.shopType)) return ui.notifications.warn(`That item does not match the ${SHOP_TYPES[this.shopType]} shop type.`);
    const stock = foundry.utils.deepClone(this.actor.getFlag(MODULE_ID, "stock") ?? []);
    const existing = stock.find(entry => entry.sourceUuid === source._stats?.compendiumSource || entry.name === source.name);
    if (existing) existing.quantity = Number(existing.quantity || 0) + quantity;
    else stock.push({ id: foundry.utils.randomID(), name: source.name, img: source.img, type: source.type, system: source.system ?? {}, sourceUuid: source._stats?.compendiumSource ?? "", quantity });
    await this.actor.setFlag(MODULE_ID, "stock", stock); this.render();
  }
  static async #removeItem(_event, target) {
    const id = target.dataset.id; const stock = (this.actor.getFlag(MODULE_ID, "stock") ?? []).filter(x => x.id !== id);
    await this.actor.setFlag(MODULE_ID, "stock", stock); this.render();
  }
  static async #generate() {
    const packIds = [...this.element.querySelectorAll("[name='sourcePack']:checked")].map(el => el.value);
    const candidates = [];
    for (const id of packIds) {
      const pack = game.packs.get(id); if (!pack) continue;
      await pack.getIndex();
      for (const entry of pack.index) {
        if (entry.type && !["weapon", "equipment", "tool", "consumable", "loot", "spell"].includes(entry.type) && this.shopType !== "general") continue;
        const item = await pack.getDocument(entry._id);
        if (item && itemMatchesShop(item, this.shopType)) candidates.push(item);
      }
    }
    const count = Math.min(game.settings.get(MODULE_ID, "randomCount"), candidates.length);
    for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
    for (const item of candidates.slice(0, count)) await this.#addStock(item.toObject());
    if (!count) ui.notifications.warn("No matching items were found in the selected compendiums.");
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
    const id = target.dataset.id, stock = foundry.utils.deepClone(this.actor.getFlag(MODULE_ID, "stock") ?? []), entry = stock.find(x => x.id === id);
    if (!entry) return ui.notifications.warn("This item is no longer in stock.");
    const buyerId = this.element.querySelector("[name='buyer']")?.value;
    const buyer = game.actors.get(buyerId); if (!buyer) return ui.notifications.warn("Choose a buyer first.");
    if (!game.user.isGM && !buyer.isOwner) return ui.notifications.error("You can only purchase for a character you own.");
    const price = entry.system?.price ?? {};
    const denom = price.denomination ?? price.currency ?? "gp";
    const value = Number(price.value ?? price.amount ?? 0);
    if (!(value > 0) || !CURRENCY[denom]) return ui.notifications.warn("Set a valid item price before selling it.");
    const copper = Math.ceil(value * CURRENCY[denom]);
    const buyerFunds = foundry.utils.deepClone(buyer.system.currency ?? {});
    const total = Object.entries(CURRENCY).reduce((sum, [k, v]) => sum + Number(buyerFunds[k] ?? 0) * v, 0);
    if (total < copper) return ui.notifications.warn(`${buyer.name} does not have enough funds.`);
    const remaining = total - copper;
    // Re-denominate the exact remaining value so a buyer can pay with any mix of coins.
    let balance = remaining;
    for (const [k, v] of Object.entries(CURRENCY)) { buyerFunds[k] = Math.floor(balance / v); balance %= v; }
    const merchantFunds = foundry.utils.deepClone(this.actor.system.currency ?? {});
    let credit = copper;
    for (const [k, v] of Object.entries(CURRENCY)) { merchantFunds[k] = Number(merchantFunds[k] ?? 0) + Math.floor(credit / v); credit %= v; }
    const source = entry.system ? { name: entry.name, type: entry.type, img: entry.img, system: foundry.utils.deepClone(entry.system) } : null;
    if (!source) return ui.notifications.error("Stock item data is missing.");
    source.system.quantity = Number(source.system.quantity ?? 1);
    await buyer.createEmbeddedDocuments("Item", [source]);
    await buyer.update({ "system.currency": buyerFunds }); await this.actor.update({ "system.currency": merchantFunds });
    entry.quantity = Number(entry.quantity ?? 1) - 1;
    if (entry.quantity <= 0) stock.splice(stock.indexOf(entry), 1);
    await this.actor.setFlag(MODULE_ID, "stock", stock); this.render();
  }
  _onDrop(event) {
    super._onDrop?.(event);
    const data = TextEditor.getDragEventData(event);
    if (data?.type !== "Item") return;
    event.preventDefault();
    (async () => { const item = await fromUuid(data.uuid); if (item) await this.#addStock(item.toObject()); })();
  }
}

Hooks.on("renderMerchantNPC", (_app, _html) => {});
