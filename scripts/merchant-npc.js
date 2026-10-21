const MODULE_ID = "merchant-npc";
const CURRENCY = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
const FLOAT_PRESETS = [["Poor", 200], ["Average", 500], ["Rich", 1000]];
const SHOP_TYPES = { general: "Standard Merchant", jeweller: "Jeweller" };
const ITEM_CATEGORIES = [
  ["potions", "Potions"], ["weapons", "Weapons"], ["armour", "Armour"],
  ["magic", "Magic Items"], ["equipment", "Normal Equipment"]
];
const pendingPurchases = new Map();
// Keep the indexed catalog for this client session so reopening Add Items does
// not repeat compendium indexing and item/description classification.
let indexedCatalog = null;
let indexingCatalog = null;

function priceLabel(price = {}) { return `${price.value ?? price.amount ?? 0} ${price.denomination ?? price.currency ?? "gp"}`; }
function isItemDocument(document) { return document?.documentName === "Item"; }
function isConfiguredShop(actor) { return Boolean(actor?.type === "npc" && actor.getFlag(MODULE_ID, "isShop") === true); }
function getConfiguredShopActor(token) {
  const tokenActor = token?.actor;
  if (isConfiguredShop(tokenActor)) return tokenActor;
  const baseActor = token?.document?.actorId ? game.actors.get(token.document.actorId) : null;
  return isConfiguredShop(baseActor) ? baseActor : tokenActor;
}
function stripHTML(value = "") { const template = document.createElement("template"); template.innerHTML = String(value); return (template.content.textContent ?? "").trim(); }
function hasMagicalProperty(properties) {
  if (properties instanceof Set || properties instanceof Map) properties = [...properties.keys()];
  if (Array.isArray(properties)) return properties.some(value => ["magical", "mgc"].includes(String(value?.key ?? value?.id ?? value).toLowerCase()));
  if (typeof properties === "string") return ["magical", "mgc"].includes(properties.toLowerCase());
  if (properties && typeof properties === "object") {
    return Object.entries(properties).some(([key, value]) => ["magical", "mgc"].includes(key.toLowerCase()) && value !== false && value != null);
  }
  return false;
}
function classifyItem(item) {
  if (item.type === "spell") return null;
  const system = item.system ?? {};
  const subtype = String(system.type?.value ?? system.type ?? system.consumableType ?? "").toLowerCase();
  const magical = system.magical === true || String(system.magical).toLowerCase() === "magical" || hasMagicalProperty(system.properties) || hasMagicalProperty(item.properties);
  const isWeapon = item.type === "weapon" || (item.type === "equipment" && /melee|ranged/.test(subtype));
  const armour = item.type === "equipment" && Boolean(system.armor || /armou?r/.test(subtype) || ["light", "medium", "heavy", "shield"].includes(subtype));
  const potion = item.type === "consumable" && (subtype.includes("potion") || String(system.identifier ?? "").toLowerCase().includes("potion"));
  // Specific physical categories take priority over magical status.
  if (isWeapon) return "weapons";
  if (armour) return "armour";
  if (potion) return "potions";
  if (["equipment", "loot", "container", "tool"].includes(item.type) && magical) return "magic";
  if (["equipment", "tool", "loot", "container"].includes(item.type)) return "equipment";
  return null;
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "randomCount", { name: "Random stock count", hint: "Default number of items added by random compendium generation.", scope: "world", config: true, type: Number, default: 10, range: { min: 1, max: 100, step: 1 } });
});

Hooks.once("ready", () => {
  game.merchantNPC = { open: async (actor) => {
    if (!actor) return ui.notifications.warn("Merchant NPC could not be found.");
    try {
      if (game.user.isGM) await actor.setFlag(MODULE_ID, "isShop", true);
      const sheet = new MerchantSheet(actor);
      await sheet.render(true);
      return sheet;
    } catch (error) {
      console.error(`${MODULE_ID} | Could not open merchant shop`, { actor: actor?.name, error });
      ui.notifications.error(`Could not open ${actor.name}'s shop. Check the browser console for Merchant NPC details.`);
      return null;
    }
  } };
  // In v13 the normal canvas double-click is handled by TokenLayer, not Token.
  // Resolve the placeable from the PIXI event target's parent chain and intercept
  // only configured shops the player cannot open as character sheets.
  const installTokenDoubleClick = () => {
    const tokenLayerPrototype = canvas.tokens?.constructor?.prototype;
    if (!tokenLayerPrototype?._onClickLeft2 || tokenLayerPrototype._merchantNPCWrapped) return;
    const originalDoubleClick = tokenLayerPrototype._onClickLeft2;
    tokenLayerPrototype._onClickLeft2 = function(event, ...args) {
      let target = event?.target ?? event?.currentTarget;
      let token = null;
      while (target) {
        if (target.document?.documentName === "Token" || target.document?.actorId) {
          token = target;
          break;
        }
        target = target.parent;
      }
      const actor = getConfiguredShopActor(token);
      if (!game.user.isGM && actor?.type === "npc") {
        event?.stopPropagation?.();
        if (isConfiguredShop(actor)) void game.merchantNPC.open(actor);
        return;
      }
      return originalDoubleClick.call(this, event, ...args);
    };
    tokenLayerPrototype._merchantNPCWrapped = true;
    console.info(`${MODULE_ID} | TokenLayer shop double-click handler installed.`);
  };
  Hooks.on("canvasReady", installTokenDoubleClick);
  installTokenDoubleClick();
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
  Hooks.on("getActorDirectoryEntryContext", (_html, entries) => entries.push({
    name: "Set Up Merchant Shop", icon: '<i class="fas fa-store"></i>',
    condition: (li) => game.user.isGM && game.actors.get(li.data("documentId"))?.type === "npc" && !isConfiguredShop(game.actors.get(li.data("documentId"))),
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
      if (game.user.isGM || actor?.type !== "npc") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isConfiguredShop(actor)) game.merchantNPC.open(actor);
    }, true);
  });
  // Token HUD gives players without actor-sheet permission a reliable canvas entry point.
  Hooks.on("renderTokenHUD", (hud, html) => {
    const actor = getConfiguredShopActor(hud.object ?? hud.document);
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root || !isConfiguredShop(actor) || game.user.isGM || root.querySelector(".merchant-token-shop")) return;
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
    const configuredShop = isConfiguredShop(actor);
    if (!game.user.isGM) {
      Promise.resolve(app.close()).then(() => {
        if (configuredShop) game.merchantNPC.open(actor);
      });
      return;
    }
    if (!configuredShop) return;
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
function currencyText(currency = {}) {
  const parts = Object.keys(CURRENCY).map(key => [key, Number(currency[key] ?? 0)]).filter(([, amount]) => amount > 0).map(([key, amount]) => `${amount} ${key}`);
  return parts.join(", ") || "0 cp";
}
function copperText(amount) {
  return Object.entries(currencyFromCopper(amount)).filter(([, value]) => value > 0).map(([key, value]) => `${value} ${key}`).join(", ") || "0 cp";
}
function promptPurchase({ item, buyer, stockEntry }) {
  return new Promise(resolve => {
    const price = stockEntry.system?.price ?? {};
    const denomination = String(price.denomination ?? "gp").toLowerCase();
    const coinValue = CURRENCY[denomination];
    const rawPrice = price.value ?? price.amount;
    const hasPrice = rawPrice !== undefined && rawPrice !== null && rawPrice !== "";
    const unitCost = Math.round(Number(rawPrice) * coinValue);
    const availableFunds = copperValue(buyer.system.currency ?? {});
    const availableStock = Math.max(0, Math.floor(Number(stockEntry.quantity) || 0));
    const overlay = document.createElement("div");
    overlay.className = "merchant-purchase-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    const panel = document.createElement("section");
    panel.className = "merchant-purchase-dialog";
    const heading = document.createElement("h2");
    heading.textContent = `Purchase ${item.name}`;
    const unit = document.createElement("p");
    unit.textContent = `Price each: ${priceLabel(price)}`;
    const label = document.createElement("label");
    label.textContent = "Quantity";
    const quantity = document.createElement("input");
    quantity.type = "number";
    quantity.name = "purchaseQuantity";
    quantity.min = "1";
    quantity.step = "1";
    quantity.max = String(availableStock);
    quantity.value = "1";
    label.append(quantity);
    const funds = document.createElement("p");
    funds.textContent = `Your funds: ${currencyText(buyer.system.currency ?? {})} (${copperText(availableFunds)} total)`;
    const total = document.createElement("p");
    total.className = "purchase-total";
    const status = document.createElement("p");
    status.className = "purchase-status";
    const actions = document.createElement("div");
    actions.className = "purchase-dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = "Confirm Purchase";
    actions.append(cancel, confirm);
    panel.append(heading, unit, label, funds, total, status, actions);
    overlay.append(panel);
    document.body.append(overlay);
    const close = result => {
      overlay.remove();
      resolve(result);
    };
    const update = () => {
      const count = Math.floor(Number(quantity.value));
      const validPrice = hasPrice && Number.isSafeInteger(unitCost) && unitCost >= 0;
      const validQuantity = Number.isSafeInteger(count) && count > 0;
      const cost = validQuantity && validPrice ? unitCost * count : Number.POSITIVE_INFINITY;
      total.textContent = Number.isFinite(cost) ? `Total: ${copperText(cost)}` : "Total: —";
      if (!hasPrice) status.textContent = "No price is set. Ask the DM to set a price before purchasing.";
      else if (!validPrice) status.textContent = "This item has an invalid price. Ask the DM to check it.";
      else if (!validQuantity) status.textContent = "Enter a quantity of at least 1.";
      else if (count > availableStock) status.textContent = `Only ${availableStock} available. Reduce the quantity.`;
      else if (cost > availableFunds) status.textContent = "Insufficient funds. Reduce the quantity to continue.";
      else status.textContent = "You have enough funds for this purchase.";
      confirm.disabled = !validPrice || !validQuantity || count > availableStock || cost > availableFunds;
    };
    quantity.addEventListener("input", update);
    cancel.addEventListener("click", () => close(null));
    confirm.addEventListener("click", () => close({ quantity: Math.floor(Number(quantity.value)) }));
    overlay.addEventListener("click", event => { if (event.target === overlay) close(null); });
    overlay.addEventListener("keydown", event => { if (event.key === "Escape") close(null); });
    update();
    quantity.focus();
  });
}

const purchaseQueues = new Map();
async function processPurchase(request) {
  const previous = purchaseQueues.get(request.actorId) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  purchaseQueues.set(request.actorId, current);
  await previous;
  try { return await commitPurchase(request); }
  finally {
    release();
    if (purchaseQueues.get(request.actorId) === current) purchaseQueues.delete(request.actorId);
  }
}

async function commitPurchase({ actorId, actorUuid, buyerId, stockId, userId, quantity = 1 }) {
  // A shop can be opened from an unlinked token, where its synthetic actor may
  // have different stock from the base world actor with the same actor id.
  let merchant = actorUuid ? await fromUuid(actorUuid).catch(() => null) : null;
  merchant ??= game.actors.get(actorId);
  const buyer = game.actors.get(buyerId), requestingUser = game.users.get(userId);
  if (!merchant || !buyer || !requestingUser || (!requestingUser.isGM && requestingUser.character?.id !== buyer.id)) return { success: false, message: "The selected buyer is not assigned to your user." };
  if (!requestingUser.isGM && !buyer.testUserPermission(requestingUser, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER)) return { success: false, message: "You do not own that character." };
  let stock = foundry.utils.deepClone(merchant.getFlag(MODULE_ID, "stock") ?? []), entry = stock.find(item => item.id === stockId);
  const count = Math.floor(Number(quantity));
  if (!Number.isSafeInteger(count) || count < 1) return { success: false, message: "Choose a valid purchase quantity." };
  if (!entry || Number(entry.quantity) < count) return { success: false, message: `Only ${Math.max(0, Number(entry?.quantity) || 0)} available. Reduce the quantity.` };
  const price = entry.system?.price ?? {}, rawPrice = price.value ?? price.amount, denomination = String(price.denomination ?? "gp").toLowerCase(), coinValue = CURRENCY[denomination];
  const hasPrice = rawPrice !== undefined && rawPrice !== null && rawPrice !== "";
  if (!hasPrice) return { success: false, message: "This item has no price set. Ask the DM to set a price before purchasing." };
  const unitCost = Math.round(Number(rawPrice) * coinValue);
  const cost = unitCost * count;
  if (!Number.isSafeInteger(unitCost) || unitCost < 0 || !Number.isSafeInteger(cost)) return { success: false, message: "This item has an invalid price." };
  let buyerCurrency = buyer.system.currency ?? {}, merchantCurrency = merchant.system.currency ?? {};
  if (copperValue(buyerCurrency) < cost) return { success: false, message: `Insufficient funds. Your current purse is ${currencyText(buyerCurrency)}; reduce the quantity.` };
  // Re-read the live listing before committing so the transaction cannot use
  // stale stock or price data from when the shop was first opened.
  stock = foundry.utils.deepClone(merchant.getFlag(MODULE_ID, "stock") ?? []);
  entry = stock.find(item => item.id === stockId);
  if (!entry || Number(entry.quantity) < count) return { success: false, message: `Only ${Math.max(0, Number(entry?.quantity) || 0)} available. Reduce the quantity.` };
  const currentPrice = entry.system?.price ?? {};
  const currentRawPrice = currentPrice.value ?? currentPrice.amount;
  const currentDenomination = String(currentPrice.denomination ?? "gp").toLowerCase();
  if (currentRawPrice === undefined || currentRawPrice === null || currentRawPrice === "" || Number(currentRawPrice) !== Number(rawPrice) || currentDenomination !== denomination) {
    return { success: false, message: "The shop price changed while the purchase was being approved. Please try again." };
  }
  // Approval can take time; re-read the purse before committing so intervening
  // actor changes are not overwritten by a stale currency snapshot.
  buyerCurrency = buyer.system.currency ?? {};
  merchantCurrency = merchant.system.currency ?? {};
  if (copperValue(buyerCurrency) < cost) return { success: false, message: `Insufficient funds. Your current purse is ${currencyText(buyerCurrency)}; reduce the quantity.` };
  const originalStock = foundry.utils.deepClone(merchant.getFlag(MODULE_ID, "stock") ?? []);
  let createdItemIds = [];
  let buyerUpdated = false;
  let merchantUpdated = false;
  let stockUpdated = false;
  let stage = "loading the item data";
  try {
    let sourceItem = null;
    if (entry.sourceUuid) {
      try { sourceItem = await fromUuid(entry.sourceUuid); }
      catch (error) { console.warn(`${MODULE_ID} | Could not resolve source item; using saved shop item data instead.`, error); }
    }
    const itemData = sourceItem?.toObject?.() ?? { name: entry.name, type: entry.type, img: entry.img, system: foundry.utils.deepClone(entry.system ?? {}) };
    delete itemData._id;
    delete itemData._stats;
    itemData.system ??= {};
    itemData.system.quantity = count;
    delete itemData.system._source;
    stage = "adding the item to the character inventory";
    const created = await buyer.createEmbeddedDocuments("Item", [itemData]);
    createdItemIds = created.map(item => item.id);
    stage = "deducting the character's money";
    await buyer.update({ "system.currency": currencyFromCopper(copperValue(buyerCurrency) - cost) });
    buyerUpdated = true;
    stage = "crediting the merchant's funds";
    await merchant.update({ "system.currency": currencyFromCopper(copperValue(merchantCurrency) + cost) });
    merchantUpdated = true;
    stage = "updating the shop stock";
    entry.quantity = Number(entry.quantity) - count;
    await merchant.setFlag(MODULE_ID, "stock", stock);
    stockUpdated = true;
    const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
    const gmIds = game.users.filter(user => user.isGM).map(user => user.id);
    const card = `<div class="merchant-purchase-card"><h3>Merchant Purchase</h3><p><strong>${escape(requestingUser.name)}</strong> purchased <strong>${count} × ${escape(entry.name)}</strong> from ${escape(merchant.name)} for ${escape(copperText(cost))}.</p></div>`;
    void ChatMessage.create({ content: card, whisper: gmIds }).catch(error => console.error(`${MODULE_ID} | Could not create purchase chat card.`, error));
    return { success: true, message: `Purchased ${count} × ${entry.name} for ${copperText(cost)}.` };
  } catch (error) {
    console.error(`${MODULE_ID} | Purchase failed while ${stage}.`, error);
    try {
      if (stockUpdated) await merchant.setFlag(MODULE_ID, "stock", originalStock);
      if (merchantUpdated) await merchant.update({ "system.currency": merchantCurrency });
      if (buyerUpdated) await buyer.update({ "system.currency": buyerCurrency });
      if (createdItemIds.length) await buyer.deleteEmbeddedDocuments("Item", createdItemIds);
    } catch (rollbackError) { console.error(`${MODULE_ID} | Purchase rollback also failed.`, rollbackError); }
    return { success: false, message: `The purchase failed while ${stage}: ${error.message ?? error}. No purchase should have been completed; check the GM console if the problem continues.` };
  }
}
function requestPurchase(actorId, actorUuid, buyerId, stockId, quantity) {
  return new Promise(resolve => {
    const requestId = foundry.utils.randomID(); pendingPurchases.set(requestId, resolve);
    game.socket.emit(`module.${MODULE_ID}`, { kind: "purchase-request", requestId, actorId, actorUuid, buyerId, stockId, quantity, userId: game.user.id });
      window.setTimeout(() => {
      if (!pendingPurchases.has(requestId)) return;
      pendingPurchases.delete(requestId);
        resolve({ success: false, message: "The purchase could not be processed. An active GM must be connected to update the shop and complete the transaction." });
      }, 130000);
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
  _onRender(context, options) {
    super._onRender?.(context, options);
    if (this._restoreShopScrollTop !== undefined) {
      const scrollTop = this._restoreShopScrollTop;
      delete this._restoreShopScrollTop;
      requestAnimationFrame(() => {
        const scrollPane = this.element.querySelector(".merchant-layout");
        if (scrollPane) scrollPane.scrollTop = scrollTop;
      });
    }
    for (const input of this.element.querySelectorAll(".price-input input[name='price']")) {
      const updatePriceColor = () => {
        const value = input.value.trim();
        input.classList.toggle("price-zero", value === "" || !Number.isFinite(Number(value)) || Number(value) === 0);
      };
      input.addEventListener("input", updatePriceColor);
      updatePriceColor();
    }
  }
  get title() { return `${this.actor.name} — ${SHOP_TYPES[this.shopType] ?? SHOP_TYPES.general}`; }
  async _prepareContext() {
    this.shopType = this.actor.getFlag(MODULE_ID, "shopType") ?? this.shopType ?? "general";
    const stock = this.actor.getFlag(MODULE_ID, "stock") ?? [];
    return {
      actor: this.actor,
      stock: stock.map(item => {
        const price = item.system?.price;
        const hasPrice = price?.value !== undefined && price?.value !== null && price?.value !== "";
        return { ...item, hasPrice, priceMissing: !hasPrice, priceZero: !hasPrice || Number(price.value) === 0, priceText: hasPrice ? priceLabel(price) : "Price not set", denomination: price?.denomination ?? "gp", description: stripHTML(item.system?.description?.value ?? item.system?.description ?? "") };
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
    this._restoreShopScrollTop = this.element.querySelector(".merchant-layout")?.scrollTop ?? 0;
    this.render();
  }
  static async #setFloat() {
    if (!game.user.isGM) return ui.notifications.error("Only the GM can set a merchant's starting float.");
    this.shopType = this.actor.getFlag(MODULE_ID, "shopType") ?? "general";
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
    this.shopType = SHOP_TYPES[type] ? type : "general";
    await this.actor.setFlag(MODULE_ID, "shopType", this.shopType);
    await this.actor.setFlag(MODULE_ID, "isShop", true);
    this.render();
  }
  static async #buy(_event, target) {
    const buyer = game.user.character;
    if (!buyer) return ui.notifications.warn("Assign your user a character in User Configuration before purchasing.");
    const stockEntry = (this.actor.getFlag(MODULE_ID, "stock") ?? []).find(item => item.id === target.dataset.id);
    if (!stockEntry || Number(stockEntry.quantity) < 1) return ui.notifications.warn("That item is out of stock.");
    const purchase = await promptPurchase({ item: stockEntry, buyer, stockEntry });
    if (!purchase) return;
    const result = game.user.isGM
      ? await processPurchase({ actorId: this.actor.id, actorUuid: this.actor.uuid, buyerId: buyer.id, stockId: target.dataset.id, quantity: purchase.quantity, userId: game.user.id })
      : await requestPurchase(this.actor.id, this.actor.uuid, buyer.id, target.dataset.id, purchase.quantity);
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
    this.loadingDialog = null;
    this.loadingStartedAt = 0;
    this.filterLoading = false;
  }
  static DEFAULT_OPTIONS = {
    id: "merchant-item-browser", tag: "form", classes: ["merchant-item-browser"], window: { title: "Add Items to Shop", resizable: true }, position: { width: 1050, height: 720 },
    form: { handler: ItemBrowser.#onSubmit, submitOnChange: false },
    actions: { addItem: ItemBrowser.#addItem, randomItems: ItemBrowser.#randomItems, rollTable: ItemBrowser.#rollTable, done: ItemBrowser.#done }
  };
  static PARTS = { form: { template: "modules/merchant-npc/templates/item-browser.hbs" } };
  #showLoadingDialog() {
    if (this.loadingDialog?.isConnected) return;
    this.loadingStartedAt = performance.now();
    this.loadingDialog = document.createElement("div");
    this.loadingDialog.className = "merchant-loading-dialog";
    this.loadingDialog.setAttribute("role", "alertdialog");
    this.loadingDialog.setAttribute("aria-modal", "true");
    this.loadingDialog.innerHTML = '<div class="merchant-loading-message">Compendiums Loading - Please Wait</div>';
    document.body.append(this.loadingDialog);
  }
  #hideLoadingDialog() {
    const dialog = this.loadingDialog;
    if (!dialog) return;
    this.loadingDialog = null;
    const delay = Math.max(0, 250 - (performance.now() - this.loadingStartedAt));
    window.setTimeout(() => {
      dialog.remove();
    }, delay);
  }
  _onRender(context, options) {
    super._onRender?.(context, options);
    if (this.filterLoading) {
      this.filterLoading = false;
      this.#hideLoadingDialog();
    }
    const refresh = () => {
      this.search = this.element.querySelector("[name='itemSearch']")?.value ?? "";
      this.render();
    };
    for (const checkbox of this.element.querySelectorAll("[name='itemType']")) checkbox.addEventListener("change", () => {
      this.selectedTypes = new Set([...this.element.querySelectorAll("[name='itemType']:checked")].map(input => input.value));
      this.filterLoading = true;
      this.#showLoadingDialog();
      refresh();
    });
    for (const checkbox of this.element.querySelectorAll("[name='itemSource']")) checkbox.addEventListener("change", () => {
      this.selectedSources = new Set([...this.element.querySelectorAll("[name='itemSource']:checked")].map(input => input.value));
      refresh();
    });
    const search = this.element.querySelector("[name='itemSearch']");
    if (search) search.addEventListener("change", refresh);
  }
  async #loadCatalog() {
    if (this.catalog) return this.catalog;
    if (indexedCatalog) {
      this.catalog = indexedCatalog;
      return indexedCatalog;
    }
    if (indexingCatalog) {
      this.catalog = await indexingCatalog;
      return this.catalog;
    }
    this.#showLoadingDialog();
    indexingCatalog = (async () => {
      const sources = [];
      const worldItems = game.items.contents.map(item => ({ _id: item.id, name: item.name, img: item.img, type: item.type, category: classifyItem(item), description: stripHTML(item.system?.description?.value ?? item.system?.description ?? ""), source: "world-items" })).filter(item => item.category);
      if (worldItems.length) sources.push({ id: "world-items", label: "World Items", items: worldItems, world: true });
      for (const pack of game.packs.filter(candidate => candidate.documentName === "Item")) {
        await pack.getIndex({ fields: ["system.type.value", "system.armor", "system.rarity", "system.attunement", "system.properties", "system.magical", "system.identifier", "system.description.value", "system.description"] });
        const items = [...pack.index].map(entry => ({ _id: entry._id, name: entry.name, img: entry.img, type: entry.type, category: classifyItem(entry), description: stripHTML(entry.system?.description?.value ?? entry.system?.description ?? ""), source: pack.collection })).filter(item => item.category);
        if (items.length >= 5) sources.push({ id: pack.collection, label: pack.title, items, world: false });
      }
      sources.sort((a, b) => a.label.localeCompare(b.label));
      indexedCatalog = sources;
      return sources;
    })();
    try {
      this.catalog = await indexingCatalog;
      return this.catalog;
    }
    finally {
      this.#hideLoadingDialog();
      indexingCatalog = null;
    }
  }
  async _prepareContext() {
    const sources = await this.#loadCatalog();
    const typeOptions = ITEM_CATEGORIES.map(([value, label]) => ({ value, label, checked: this.selectedTypes.has(value) }));
    const matchingSources = sources.filter(source => {
      const matchingCount = source.items.filter(item => this.selectedTypes.has(item.category)).length;
      // The five-item minimum applies to the compendium as a whole, not to each
      // selected category. Otherwise a pack with only one magical item is hidden.
      return matchingCount > 0;
    });
    if (this.selectedSources === null && this.selectedTypes.size) this.selectedSources = new Set(matchingSources.map(source => source.id));
    if (this.selectedSources) this.selectedSources = new Set([...this.selectedSources].filter(id => sources.some(source => source.id === id)));
    const sourceOptions = matchingSources.map(source => ({ id: source.id, label: source.label, count: source.items.filter(item => this.selectedTypes.has(item.category)).length, checked: this.selectedSources.has(source.id) }));
    const query = this.search.trim().toLowerCase();
    this.visibleItems = matchingSources.filter(source => this.selectedSources?.has(source.id)).flatMap(source => source.items
      .filter(item => this.selectedTypes.has(item.category) && (!query || item.name.toLowerCase().includes(query)))
      .map(item => ({ ...item, typeLabel: ITEM_CATEGORIES.find(([value]) => value === item.category)?.[1] ?? item.type, sourceLabel: sources.find(source => source.id === item.source)?.label ?? item.source })))
      .sort((a, b) => a.name.localeCompare(b.name));
    const tables = await getRollTables(this.selectedTypes);
    return { actor: this.actor, types: typeOptions, sources: sourceOptions, items: this.visibleItems, tables, search: this.search, randomCount: game.settings.get(MODULE_ID, "randomCount"), isGM: game.user.isGM };
  }
  static async #onSubmit() {}
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
