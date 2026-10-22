const MODULE_ID = "merchant-npc";
const CURRENCY = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
const FLOAT_PRESETS = [["Poor", 200], ["Average", 500], ["Rich", 1000]];
const SHOP_TYPES = { general: "Standard Merchant", jeweller: "Jeweller" };
const ITEM_CATEGORIES = [
  ["potions", "Potions"], ["weapons", "Weapons"], ["armour", "Armour"],
  ["magic", "Magic Items"], ["equipment", "Normal Equipment"]
];
const pendingPurchases = new Map();
const pendingApprovals = new Map();
const cachedSourceItemData = new Map();
const catalogSubscribers = new Set();
// Keep the indexed catalog for this client session so reopening Add Items does
// not repeat compendium indexing and item/description classification.
let indexedCatalog = null;
let indexingCatalog = null;
let indexedRollTableCatalog = null;
let indexingRollTableCatalog = null;

function priceLabel(price = {}) { return `${price.value ?? price.amount ?? 0} ${price.denomination ?? price.currency ?? "gp"}`; }
function isItemDocument(document) { return document?.documentName === "Item"; }
async function mapWithConcurrency(items, limit, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, limit));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index], index);
    }
  }));
  return results;
}
function isConfiguredShop(actor) { return Boolean(actor?.type === "npc" && actor.getFlag(MODULE_ID, "isShop") === true); }
function refreshCatalogBrowsers() {
  for (const browser of catalogSubscribers) {
    browser.catalog = indexedCatalog;
    if (browser.element?.isConnected) browser.render();
  }
}
function withTimeout(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds); })
  ]).finally(() => window.clearTimeout(timer));
}
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
  game.settings.register(MODULE_ID, "zeroPriceApproval", {
    name: "Zero-price purchase approval",
    hint: "Choose how the GM approves purchases of items priced at 0.",
    scope: "world", config: true, type: String, default: "chat",
    choices: { chat: "GM chat card", dialog: "GM pop-up dialog" }
  });
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
  Hooks.on("createChatMessage", async (message, _options, userId) => {
    const request = message.getFlag(MODULE_ID, "purchaseRequest");
    if (request && game.user.isGM && game.users.activeGM?.id === game.user.id) {
      // The create hook's userId is supplied by Foundry for the authenticated
      // document operation. Never authorize from an ID carried in the payload.
      await message.delete().catch(error => console.warn(`${MODULE_ID} | Could not remove the private purchase transport message.`, error));
      let result;
      try { result = await processPurchase(request, userId); }
      catch (error) {
        console.error(`${MODULE_ID} | Purchase request failed before completion.`, error);
        result = { success: false, message: "The purchase request could not be processed. Check the GM console." };
      }
      if (result?.pending) return;
      await sendPurchaseResult(userId, request.requestId, result);
      return;
    }
    const response = message.getFlag(MODULE_ID, "purchaseResult");
    if (!response || response.recipientId !== game.user.id || !game.users.get(userId)?.isGM) return;
    const pending = pendingPurchases.get(response.requestId);
    if (pending) {
      pendingPurchases.delete(response.requestId);
      window.clearTimeout(pending.timeoutId);
      pending.resolve(response.result);
    } else if (!response.result?.pending) {
      if (response.result?.success) ui.notifications.info(response.result.message);
      else ui.notifications.warn(response.result?.message ?? "The purchase could not be completed.");
    }
  });
  Hooks.on("renderChatMessageHTML", (message, html) => {
    const approval = message.getFlag(MODULE_ID, "purchaseApproval");
    if (!approval || approval.status !== "pending" || !game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
    for (const button of html.querySelectorAll("[data-merchant-approval]")) {
      button.addEventListener("click", async event => {
        event.preventDefault();
        const approve = button.dataset.merchantApproval === "approve";
        await resolvePurchaseApproval(message, approval.requestId, approve);
      }, { once: true });
    }
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
function resolveMerchant(request) {
  if (request.actorUuid?.startsWith("Actor.")) return Promise.resolve(game.actors.get(request.actorId) ?? null);
  if (request.actorUuid) return fromUuid(request.actorUuid).catch(() => null);
  return Promise.resolve(game.actors.get(request.actorId) ?? null);
}
function sendPurchaseResult(recipientId, requestId, result) {
  if (!recipientId || !game.users.get(recipientId)) return Promise.resolve();
  const message = foundry.utils.escapeHTML(String(result?.message ?? "The purchase could not be completed."));
  return ChatMessage.create({
    content: `<div class="merchant-purchase-result">${message}</div>`,
    whisper: [recipientId],
    flags: { [MODULE_ID]: { purchaseResult: { requestId, recipientId, result } } }
  }).catch(error => console.error(`${MODULE_ID} | Could not send purchase result.`, error));
}
function purchaseApprovalCard({ requestId, requester, merchant, entry, quantity }) {
  const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
  return `<div class="merchant-approval-card" data-request-id="${escape(requestId)}"><h3>Free Purchase Approval</h3><p><strong>${escape(requester.name)}</strong> requests ${quantity} × <strong>${escape(entry.name)}</strong> from ${escape(merchant.name)}.</p><p>This item has a total price of 0.</p><button type="button" data-merchant-approval="approve">Approve</button> <button type="button" data-merchant-approval="deny">Deny</button></div>`;
}
async function resolvePurchaseApproval(message, requestId, approved) {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id) return;
  const approval = message.getFlag(MODULE_ID, "purchaseApproval");
  const pending = pendingApprovals.get(requestId) ?? (approval?.request && approval?.requesterId
    ? { request: approval.request, requesterId: approval.requesterId }
    : null);
  if (!pending) return;
  pendingApprovals.delete(requestId);
  const result = approved
    ? await commitPurchase(pending.request, pending.requesterId)
    : { success: false, message: "The GM declined this free-item purchase." };
  const status = result.success ? "approved" : approved ? "failed" : "denied";
  const safeText = foundry.utils.escapeHTML(result.message);
  await message.update({
    content: `<div class="merchant-approval-card"><h3>Free Purchase ${status}</h3><p>${safeText}</p></div>`,
    [`flags.${MODULE_ID}.purchaseApproval.status`]: status
  });
  await sendPurchaseResult(pending.requesterId, requestId, result);
}
async function processPurchase(request, authenticatedUserId) {
  const previous = purchaseQueues.get(request.actorId) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  purchaseQueues.set(request.actorId, current);
  await previous;
  try {
    const requester = game.users.get(authenticatedUserId);
    const buyer = game.actors.get(request.buyerId);
    const merchant = await resolveMerchant(request);
    if (!requester || !buyer || !merchant || !isConfiguredShop(merchant)) return { success: false, message: "That merchant or buyer is no longer available." };
    if (!requester.isGM && (requester.character?.id !== buyer.id || !buyer.testUserPermission(requester, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER))) {
      return { success: false, message: "You do not own the selected buyer character." };
    }
    const entry = (merchant.getFlag(MODULE_ID, "stock") ?? []).find(item => item.id === request.stockId);
    const quantity = Math.floor(Number(request.quantity));
    if (!entry || !Number.isSafeInteger(quantity) || quantity < 1 || Number(entry.quantity) < quantity) return commitPurchase(request, authenticatedUserId);
    const price = entry.system?.price ?? {};
    const rawPrice = price.value ?? price.amount;
    const denomination = String(price.denomination ?? "gp").toLowerCase();
    const unitCost = Math.round(Number(rawPrice) * CURRENCY[denomination]);
    if (!requester.isGM && rawPrice !== undefined && rawPrice !== null && rawPrice !== "" && Number.isFinite(Number(rawPrice)) && Number(rawPrice) === 0) {
      const mode = game.settings.get(MODULE_ID, "zeroPriceApproval");
      if (mode === "dialog") {
        const approved = await foundry.applications.api.DialogV2.confirm({
          window: { title: "Approve Free Purchase" },
          content: purchaseApprovalCard({ requestId: request.requestId, requester, merchant, entry, quantity }).replace(/<button[^>]*>[\s\S]*?<\/button>/g, ""),
          rejectClose: false, modal: true,
          yes: { label: "Approve" }, no: { label: "Deny" }
        });
        if (!approved) return { success: false, message: "The GM declined this free-item purchase." };
      } else {
        pendingApprovals.set(request.requestId, { request, requesterId: authenticatedUserId });
        try {
          await ChatMessage.create({
            content: purchaseApprovalCard({ requestId: request.requestId, requester, merchant, entry, quantity }),
            whisper: game.users.filter(user => user.isGM).map(user => user.id),
            flags: { [MODULE_ID]: { purchaseApproval: { requestId: request.requestId, status: "pending", requesterId: authenticatedUserId, request } } }
          });
        } catch (error) {
          pendingApprovals.delete(request.requestId);
          throw error;
        }
        await sendPurchaseResult(authenticatedUserId, request.requestId, { success: true, pending: true, message: "Your free-item purchase request is waiting for GM approval." });
        return { success: true, pending: true };
      }
    }
    return await commitPurchase(request, authenticatedUserId);
  }
  finally {
    release();
    if (purchaseQueues.get(request.actorId) === current) purchaseQueues.delete(request.actorId);
  }
}

async function commitPurchase({ actorId, actorUuid, buyerId, stockId, quantity = 1 }, authenticatedUserId) {
  // A shop can be opened from an unlinked token, where its synthetic actor may
  // have different stock from the base world actor with the same actor id.
  let merchant = actorUuid?.startsWith("Actor.") ? game.actors.get(actorId) : null;
  if (!merchant && actorUuid) merchant = await fromUuid(actorUuid).catch(() => null);
  merchant ??= game.actors.get(actorId);
  const buyer = game.actors.get(buyerId), requestingUser = game.users.get(authenticatedUserId);
  if (!merchant || !buyer || !requestingUser || !isConfiguredShop(merchant)) return { success: false, message: "The selected merchant or buyer is no longer available." };
  if (!requestingUser.isGM && (requestingUser.character?.id !== buyer.id || !buyer.testUserPermission(requestingUser, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER))) return { success: false, message: "You do not own that character." };
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
  const originalStock = foundry.utils.deepClone(stock);
  let createdItemIds = [];
  let buyerUpdated = false;
  let merchantUpdated = false;
  let stockUpdated = false;
  let stage = "loading the item data";
  try {
    let itemData = entry.sourceData ? foundry.utils.deepClone(entry.sourceData) : null;
    if (!itemData && entry.sourceUuid) {
      try {
        itemData = cachedSourceItemData.get(entry.sourceUuid);
        if (!itemData) {
          const sourceItem = await fromUuid(entry.sourceUuid);
          itemData = sourceItem?.toObject?.() ?? null;
          if (itemData) cachedSourceItemData.set(entry.sourceUuid, foundry.utils.deepClone(itemData));
        }
        if (itemData) itemData = foundry.utils.deepClone(itemData);
      } catch (error) { console.warn(`${MODULE_ID} | Could not resolve source item; using saved shop item data instead.`, error); }
    }
    itemData ??= { name: entry.name, type: entry.type, img: entry.img, system: foundry.utils.deepClone(entry.system ?? {}) };
    if (entry.sourceData) {
      if (entry.sourceUuid) cachedSourceItemData.set(entry.sourceUuid, foundry.utils.deepClone(entry.sourceData));
      delete entry.sourceData;
    }
    delete itemData._id;
    delete itemData._stats;
    itemData.system ??= {};
    itemData.system.price = foundry.utils.deepClone(entry.system?.price ?? itemData.system.price ?? {});
    itemData.system.quantity = count;
    delete itemData.system._source;
    stage = "adding the item to the character inventory";
    const created = await buyer.createEmbeddedDocuments("Item", [itemData]);
    createdItemIds = created.map(item => item.id);
    stage = "deducting the character's money";
    await buyer.update({ "system.currency": currencyFromCopper(copperValue(buyerCurrency) - cost) });
    buyerUpdated = true;
    stage = "updating merchant funds and shop stock";
    entry.quantity = Number(entry.quantity) - count;
    await merchant.update({
      "system.currency": currencyFromCopper(copperValue(merchantCurrency) + cost),
      [`flags.${MODULE_ID}.stock`]: stock
    });
    merchantUpdated = true;
    stockUpdated = true;
    const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
    const gmIds = game.users.filter(user => user.isGM).map(user => user.id);
    const card = `<div class="merchant-purchase-card"><h3>Merchant Purchase</h3><p><strong>${escape(requestingUser.name)}</strong> purchased <strong>${count} × ${escape(entry.name)}</strong> from ${escape(merchant.name)} for ${escape(copperText(cost))}.</p></div>`;
    void ChatMessage.create({ content: card, whisper: gmIds }).catch(error => console.error(`${MODULE_ID} | Could not create purchase chat card.`, error));
    return { success: true, message: `Purchased ${count} × ${entry.name} for ${copperText(cost)}.` };
  } catch (error) {
    console.error(`${MODULE_ID} | Purchase failed while ${stage}.`, error);
    try {
      if (stockUpdated || merchantUpdated) await merchant.update({ "system.currency": merchantCurrency, [`flags.${MODULE_ID}.stock`]: originalStock });
      if (buyerUpdated) await buyer.update({ "system.currency": buyerCurrency });
      if (createdItemIds.length) await buyer.deleteEmbeddedDocuments("Item", createdItemIds);
    } catch (rollbackError) { console.error(`${MODULE_ID} | Purchase rollback also failed.`, rollbackError); }
    return { success: false, message: `The purchase failed while ${stage}: ${error.message ?? error}. No purchase should have been completed; check the GM console if the problem continues.` };
  }
}
function requestPurchase(actorId, actorUuid, buyerId, stockId, quantity) {
  return new Promise(resolve => {
    const requestId = foundry.utils.randomID();
    const timeoutId = window.setTimeout(() => {
      if (!pendingPurchases.has(requestId)) return;
      pendingPurchases.delete(requestId);
      resolve({ success: false, message: "The purchase request timed out. Check that a GM is connected and able to respond." });
    }, 15 * 60 * 1000);
    pendingPurchases.set(requestId, { resolve, timeoutId });
    const activeGM = game.users.activeGM;
    if (!activeGM) {
      pendingPurchases.delete(requestId);
      window.clearTimeout(timeoutId);
      resolve({ success: false, message: "An active GM must be connected to process this purchase." });
      return;
    }
    ChatMessage.create({
      content: "",
      whisper: [activeGM.id],
      flags: { [MODULE_ID]: { purchaseRequest: { requestId, actorId, actorUuid, buyerId, stockId, quantity } } }
    }).catch(error => {
      pendingPurchases.delete(requestId);
      window.clearTimeout(timeoutId);
      console.error(`${MODULE_ID} | Could not send purchase request.`, error);
      resolve({ success: false, message: "The purchase request could not be sent to the GM." });
    });
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
    return this.addStockMany([{ source, quantity }]);
  }
  async addStockMany(records) {
    if (!records.length) return;
    const stock = foundry.utils.deepClone(this.actor.getFlag(MODULE_ID, "stock") ?? []);
    for (const { source, quantity = 1 } of records) {
      const sourceUuid = source._stats?.compendiumSource ?? source.uuid ?? (source._id ? `Item.${source._id}` : `${source.type}:${source.name}`);
      const existing = stock.find(item => item.sourceUuid === sourceUuid || (!item.sourceUuid && item.name === source.name && item.type === source.type));
      const sourceData = foundry.utils.deepClone(source);
      delete sourceData._id;
      delete sourceData._stats;
      delete sourceData.uuid;
      if (sourceUuid) cachedSourceItemData.set(sourceUuid, sourceData);
      if (existing) {
        existing.quantity = Number(existing.quantity ?? 0) + quantity;
        if (existing.sourceData) {
          if (existing.sourceUuid) cachedSourceItemData.set(existing.sourceUuid, foundry.utils.deepClone(existing.sourceData));
          delete existing.sourceData;
        }
      }
      else stock.push({ id: foundry.utils.randomID(), name: source.name, img: source.img ?? "icons/svg/item-bag.svg", type: source.type, system: foundry.utils.deepClone(source.system ?? {}), sourceUuid, quantity });
    }
    await this.actor.update({ [`flags.${MODULE_ID}.stock`]: stock, [`flags.${MODULE_ID}.isShop`]: true });
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
      ? await processPurchase({ requestId: foundry.utils.randomID(), actorId: this.actor.id, actorUuid: this.actor.uuid, buyerId: buyer.id, stockId: target.dataset.id, quantity: purchase.quantity }, game.user.id)
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
    catalogSubscribers.add(this);
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
    const refresh = () => {
      this.search = this.element.querySelector("[name='itemSearch']")?.value ?? "";
      this.render();
    };
    for (const checkbox of this.element.querySelectorAll("[name='itemType']")) checkbox.addEventListener("change", () => {
      this.selectedTypes = new Set([...this.element.querySelectorAll("[name='itemType']:checked")].map(input => input.value));
      this.selectedSources = null;
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
      if (indexingCatalog) this.#showLoadingDialog();
      return indexedCatalog;
    }
    this.#showLoadingDialog();
    const worldItems = game.items.contents.map(item => ({ _id: item.id, name: item.name, img: item.img, type: item.type, category: classifyItem(item), description: stripHTML(item.system?.description?.value ?? item.system?.description ?? ""), source: "world-items" })).filter(item => item.category);
    indexedCatalog = worldItems.length ? [{ id: "world-items", label: "World Items", items: worldItems, world: true }] : [];
    this.catalog = indexedCatalog;
    if (!indexingCatalog) {
      const packs = game.packs.filter(candidate => candidate.documentName === "Item");
      indexingCatalog = mapWithConcurrency(packs, 4, async pack => {
        try {
          const source = await withTimeout((async () => {
            await pack.getIndex({ fields: ["system.type.value", "system.armor", "system.rarity", "system.attunement", "system.properties", "system.magical", "system.identifier", "system.description.value", "system.description"] });
            const items = [...pack.index].map(entry => ({ _id: entry._id, name: entry.name, img: entry.img, type: entry.type, category: classifyItem(entry), description: stripHTML(entry.system?.description?.value ?? entry.system?.description ?? ""), source: pack.collection })).filter(item => item.category);
            return items.length >= 5 ? { id: pack.collection, label: pack.title, items, world: false } : null;
          })(), 5000, `Compendium ${pack.title}`);
          if (!source) return;
          if (!indexedCatalog.some(existing => existing.id === source.id)) indexedCatalog.push(source);
          indexedCatalog.sort((a, b) => a.label.localeCompare(b.label));
          refreshCatalogBrowsers();
        } catch (error) {
          console.warn(`${MODULE_ID} | Skipping compendium '${pack.title}' after a load failure or 5-second timeout.`, error);
        }
      }).then(() => indexedCatalog).finally(() => {
        indexingCatalog = null;
        for (const browser of catalogSubscribers) browser.#hideLoadingDialog();
      });
    }
    refreshCatalogBrowsers();
    return indexedCatalog;
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
    let tables = [];
    if (this.selectedTypes.size) {
      if (indexedRollTableCatalog) {
        tables = indexedRollTableCatalog.filter(table => table.categories.some(category => this.selectedTypes.has(category))).map(({ uuid, name, source }) => ({ uuid, name, source }));
      } else {
        void getRollTables(new Set(this.selectedTypes)).then(() => {
          if (this.element?.isConnected) this.render();
        }).catch(error => console.warn(`${MODULE_ID} | Could not index rollable tables.`, error));
      }
    }
    return { actor: this.actor, types: typeOptions, sources: sourceOptions, items: this.visibleItems, tables, search: this.search, randomCount: game.settings.get(MODULE_ID, "randomCount"), isGM: game.user.isGM };
  }
  _onClose(options) {
    catalogSubscribers.delete(this);
    this.#hideLoadingDialog();
    return super._onClose?.(options);
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
    const items = (await mapWithConcurrency(selected, 6, record => this.#resolveItem(record.source, record._id))).filter(Boolean);
    if (items.length) await this.merchantSheet.addStockMany(items.map(item => ({ source: item.toObject(), quantity: 1 })));
    if (!selected.length) ui.notifications.warn("No items match the selected item types and compendiums.");
    else ui.notifications.info(`Added ${selected.length} random item${selected.length === 1 ? "" : "s"} to the shop.`);
  }
  static async #rollTable() {
    const uuid = this.element.querySelector("[name='rollTableUuid']")?.value;
    const draws = Math.max(1, Math.min(100, Number(this.element.querySelector("[name='tableDraws']")?.value ?? 1)));
    const table = uuid && await fromUuid(uuid);
    if (!table) return ui.notifications.warn("Choose a rollable table first.");
    const items = [];
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
        if (isItemDocument(item) && this.selectedTypes.has(classifyItem(item))) items.push(item.toObject());
      }
    }
    if (items.length) {
      await this.merchantSheet.addStockMany(items.map(source => ({ source, quantity: 1 })));
      ui.notifications.info(`Added ${items.length} item result${items.length === 1 ? "" : "s"} from ${table.name}.`);
    }
    else ui.notifications.warn("The selected table returned no linked Item documents. Link its results to Item documents to stock them automatically.");
  }
  static async #done() { this.close(); }
}

async function getRollTables(selectedTypes = new Set()) {
  if (!selectedTypes.size) return [];
  if (!indexedRollTableCatalog) {
    if (!indexingRollTableCatalog) {
      indexingRollTableCatalog = (async () => {
        const tableRecords = game.tables.contents.map(table => ({ table, source: "World Tables" }));
        const rollTablePacks = game.packs.filter(candidate => candidate.documentName === "RollTable");
        const packTableRecords = await mapWithConcurrency(rollTablePacks, 4, async pack => {
          try {
            return await withTimeout((async () => {
              await pack.getIndex();
              return (await mapWithConcurrency([...pack.index], 8, entry => pack.getDocument(entry._id)))
                .filter(Boolean).map(table => ({ table, source: pack.title }));
            })(), 5000, `Roll table compendium ${pack.title}`);
          } catch (error) {
            console.warn(`${MODULE_ID} | Skipping roll table compendium '${pack.title}' after a load failure or 5-second timeout.`, error);
            return [];
          }
        });
        tableRecords.push(...packTableRecords.flat());
        const categoriesByTable = new Map(tableRecords.map(({ table }) => [table.uuid, new Set()]));
        const resultJobs = tableRecords.flatMap(({ table }) => [...table.results].map(result => ({ table, result })));
        await mapWithConcurrency(resultJobs, 12, async ({ table, result }) => {
          let item;
          try { item = await result.getDocument?.(); } catch { /* Resolve linked UUIDs below. */ }
          if (!isItemDocument(item) && result.documentUuid) {
            try { item = await fromUuid(result.documentUuid); } catch { /* Ignore unresolved results. */ }
          }
          if (!isItemDocument(item) && result.documentCollection && result.documentId) {
            const uuid = result.documentCollection === "world.items" ? `Item.${result.documentId}` : `${result.documentCollection.startsWith("Compendium.") ? "" : "Compendium."}${result.documentCollection}.${result.documentId}`;
            try { item = await fromUuid(uuid); } catch { /* Ignore non-item results. */ }
          }
          const category = isItemDocument(item) && classifyItem(item);
          if (category) categoriesByTable.get(table.uuid)?.add(category);
        });
        indexedRollTableCatalog = tableRecords.map(({ table, source }) => ({
          uuid: table.uuid, name: table.name, source,
          categories: [...(categoriesByTable.get(table.uuid) ?? [])]
        })).filter(table => table.categories.length).sort((a, b) => a.name.localeCompare(b.name));
        return indexedRollTableCatalog;
      })();
    }
    try { await indexingRollTableCatalog; }
    finally { indexingRollTableCatalog = null; }
  }
  return indexedRollTableCatalog.filter(table => table.categories.some(category => selectedTypes.has(category))).map(({ uuid, name, source }) => ({ uuid, name, source }));
}
