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
const pendingSales = new Map();
const cachedSourceItemData = new Map();
const catalogSubscribers = new Set();
let catalogRefreshPending = false;
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
  if (catalogRefreshPending) return;
  catalogRefreshPending = true;
  requestAnimationFrame(() => {
    catalogRefreshPending = false;
    for (const browser of catalogSubscribers) {
      browser.catalog = indexedCatalog;
      if (browser.element?.isConnected) browser.render();
    }
  });
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
function tooltipText(value = "") {
  const template = document.createElement("template");
  template.innerHTML = String(value);
  template.content.querySelectorAll("br").forEach(node => node.replaceWith("\n"));
  template.content.querySelectorAll("p, div, li, h1, h2, h3, h4, h5, h6, blockquote, tr").forEach(node => {
    node.prepend(document.createTextNode("\n"));
    node.append(document.createTextNode("\n"));
  });
  return (template.content.textContent ?? "")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
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
    const saleRequest = message.getFlag(MODULE_ID, "saleRequest");
    if (saleRequest && game.user.isGM && game.users.activeGM?.id === game.user.id) {
      await message.delete().catch(error => console.warn(`${MODULE_ID} | Could not remove the private sale transport message.`, error));
      try { await processSaleRequest(saleRequest, userId); }
      catch (error) {
        console.error(`${MODULE_ID} | Sale request failed.`, error);
        await saleResultToPlayer(userId, saleRequest.requestId, { success: false, message: "The sale request could not be processed. Check the GM console." });
      }
      return;
    }
    const saleResponse = message.getFlag(MODULE_ID, "saleResponse");
    if (saleResponse && game.user.isGM && game.users.activeGM?.id === game.user.id) {
      await message.delete().catch(error => console.warn(`${MODULE_ID} | Could not remove the private sale response message.`, error));
      try { await processSaleResponse(saleResponse, userId); }
      catch (error) {
        console.error(`${MODULE_ID} | Sale response failed.`, error);
        const pending = pendingSales.get(saleResponse.requestId);
        if (pending) await sendSaleOffer(pending, { outcome: "The negotiation could not be processed; the current offer still stands.", persuasionUsed: true });
      }
      return;
    }
    const saleOffer = message.getFlag(MODULE_ID, "saleOffer");
    if (saleOffer?.recipientId === game.user.id && game.users.get(userId)?.isGM) {
      void showPlayerSaleOffer(saleOffer);
      return;
    }
    const saleResult = message.getFlag(MODULE_ID, "saleResult");
    if (saleResult?.recipientId === game.user.id && game.users.get(userId)?.isGM) {
      if (saleResult.result?.success) ui.notifications.info(saleResult.result.message);
      else ui.notifications.warn(saleResult.result?.message ?? "The sale could not be completed.");
      return;
    }
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
function goldText(amount) {
  const gold = Number(amount) / CURRENCY.gp;
  return `${gold.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")} gp`;
}
function itemQuantity(item) {
  const quantity = item?.system?.quantity;
  return Math.max(0, Math.floor(Number(quantity?.value ?? quantity) || 0));
}
function itemPriceCopper(item) {
  const price = item?.system?.price ?? {};
  const raw = price.value ?? price.amount;
  const denomination = String(price.denomination ?? price.currency ?? "gp").toLowerCase();
  if (raw === undefined || raw === null || raw === "" || !CURRENCY[denomination] || !Number.isFinite(Number(raw))) return null;
  return Math.max(0, Math.round(Number(raw) * CURRENCY[denomination]));
}
function saleOverlay(title, className = "") {
  const overlay = document.createElement("div");
  overlay.className = `merchant-purchase-overlay merchant-sale-overlay ${className}`.trim();
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  const panel = document.createElement("section");
  panel.className = "merchant-purchase-dialog merchant-sale-dialog";
  const heading = document.createElement("h2");
  heading.textContent = title;
  panel.append(heading);
  overlay.append(panel);
  document.body.append(overlay);
  return { overlay, panel };
}
async function requestSale(actor, merchant, items) {
  const activeGM = game.users.activeGM;
  if (!activeGM) return ui.notifications.warn("An active GM must be connected to review sale offers.");
  const requestId = foundry.utils.randomID();
  try {
    await ChatMessage.create({
      content: "", whisper: [activeGM.id],
      flags: { [MODULE_ID]: { saleRequest: { requestId, merchantId: merchant.id, merchantUuid: merchant.uuid, buyerId: actor.id, items } } }
    });
    ui.notifications.info("Your items have been sent to the merchant for an offer.");
  } catch (error) {
    console.error(`${MODULE_ID} | Could not send sale request.`, error);
    ui.notifications.error("The sale request could not be sent to the GM.");
  }
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

function saleResultToPlayer(recipientId, requestId, result) {
  if (!recipientId || !game.users.get(recipientId)) return Promise.resolve();
  return ChatMessage.create({
    content: "", whisper: [recipientId],
    flags: { [MODULE_ID]: { saleResult: { requestId, recipientId, result } } }
  }).catch(error => console.error(`${MODULE_ID} | Could not send sale result.`, error));
}
async function sendSaleOffer(sale, { outcome = "", persuasionUsed = false } = {}) {
  const lines = sale.currentOffer.lines.map(line => {
    const item = sale.items.find(record => record.itemId === line.itemId);
    return { itemId: line.itemId, name: item?.name ?? "Item", img: item?.img, quantity: line.quantity, unitValueCopper: item?.unitValueCopper, valueText: item?.valueText ?? "Value not set", offerCopper: line.offerCopper };
  });
  const totalCopper = lines.reduce((total, line) => total + line.offerCopper * line.quantity, 0);
  await ChatMessage.create({
    content: "", whisper: [sale.requesterId],
    flags: { [MODULE_ID]: { saleOffer: {
      requestId: sale.request.requestId, recipientId: sale.requesterId, buyerId: sale.buyer.id, buyerName: sale.buyer.name, merchantName: sale.merchant.name,
      lines, totalCopper, persuasionBonus: sale.persuasionBonus, persuasionUsed, outcome
    } } }
  });
}
function promptGmSaleOffer(sale, { previous = null, rollSummary = "" } = {}) {
  const sheet = new MerchantOfferSheet(sale, previous, rollSummary);
  void sheet.render(true).then(() => {
    const bounds = sheet.element?.getBoundingClientRect();
    if (bounds) sheet.setPosition({ left: Math.max(0, (window.innerWidth - bounds.width) / 2), top: Math.max(0, (window.innerHeight - bounds.height) / 2) });
  }).catch(error => {
    console.error(`${MODULE_ID} | Could not open the merchant offer sheet.`, error);
    ui.notifications.error("The merchant offer sheet could not be opened.");
    sheet.finish(null);
  });
  return sheet.result;
}
async function processSaleRequest(request, authenticatedUserId) {
  const requester = game.users.get(authenticatedUserId), buyer = game.actors.get(request.buyerId), merchant = await resolveMerchant({ actorId: request.merchantId, actorUuid: request.merchantUuid });
  if (!requester || !buyer || !merchant || !isConfiguredShop(merchant)) return saleResultToPlayer(authenticatedUserId, request.requestId, { success: false, message: "That merchant or character is no longer available." });
  if (!requester.isGM && (requester.character?.id !== buyer.id || !buyer.testUserPermission(requester, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER))) return saleResultToPlayer(authenticatedUserId, request.requestId, { success: false, message: "You do not own the character offering these items." });
  const requestedItems = new Map();
  for (const requested of request.items ?? []) requestedItems.set(requested.itemId, (requestedItems.get(requested.itemId) ?? 0) + Math.floor(Number(requested.quantity)));
  const items = [];
  for (const [itemId, quantity] of requestedItems) {
    const item = buyer.items.get(itemId);
    if (!item || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > itemQuantity(item)) continue;
    const itemData = item.toObject();
    const unitValueCopper = itemPriceCopper(item);
    items.push({ itemId: item.id, name: item.name, img: item.img, type: item.type, quantity, available: itemQuantity(item), unitValueCopper, valueText: unitValueCopper === null ? "Value not set" : priceLabel(item.system?.price ?? {}), sourceData: itemData });
  }
  if (!items.length) return saleResultToPlayer(authenticatedUserId, request.requestId, { success: false, message: "None of those items are still available in the character's inventory." });
  const sale = { request, requester, requesterId: authenticatedUserId, buyer, merchant, items, currentOffer: null, persuasionBonus: 0, persuasionUsed: false };
  pendingSales.set(request.requestId, sale);
  const offer = await promptGmSaleOffer(sale);
  if (!offer) {
    pendingSales.delete(request.requestId);
    return saleResultToPlayer(authenticatedUserId, request.requestId, { success: false, message: "The merchant declined to review this sale." });
  }
  sale.currentOffer = offer; sale.persuasionBonus = offer.persuasionBonus;
  await sendSaleOffer(sale);
}
function showPlayerSaleOffer(offer) {
  const { overlay, panel } = saleOverlay(`Offer from ${offer.merchantName} for ${offer.buyerName}`, "merchant-player-sale-offer");
  if (offer.outcome) { const outcome = document.createElement("p"); outcome.className = "merchant-sale-roll-summary"; outcome.textContent = offer.outcome; panel.append(outcome); }
  const list = document.createElement("ul"); list.className = "merchant-sale-list";
  for (const line of offer.lines) {
    const row = document.createElement("li");
    const image = document.createElement("img"); image.src = line.img ?? "icons/svg/item-bag.svg"; image.alt = "";
    const name = document.createElement("strong"); name.textContent = `${line.quantity} × ${line.name}`;
    const value = document.createElement("small"); value.textContent = `Your item's value: ${line.valueText} each · Merchant offer: ${goldText(line.offerCopper * line.quantity)}`;
    const details = document.createElement("div"); details.append(name, value);
    row.append(image, details); list.append(row);
  }
  const total = document.createElement("p"); total.className = "merchant-sale-total"; total.textContent = `Total offered: ${goldText(offer.totalCopper)}`;
  const bonus = document.createElement("p"); bonus.textContent = `GM-advised Persuasion bonus: ${offer.persuasionBonus >= 0 ? "+" : ""}${offer.persuasionBonus}`;
  const status = document.createElement("p"); status.className = "merchant-sale-status";
  const actions = document.createElement("div"); actions.className = "purchase-dialog-actions";
  const accept = document.createElement("button"); accept.type = "button"; accept.textContent = "Accept Offer";
  const persuade = document.createElement("button"); persuade.type = "button"; persuade.textContent = "Try Persuasion"; persuade.disabled = Boolean(offer.persuasionUsed);
  const decline = document.createElement("button"); decline.type = "button"; decline.textContent = "Decline";
  actions.append(accept, persuade, decline); panel.append(list, total, bonus, status, actions);
  const close = () => overlay.remove();
  const send = async response => {
    for (const button of actions.querySelectorAll("button")) button.disabled = true;
    status.textContent = "Waiting for the merchant…";
    const activeGM = game.users.activeGM;
    if (!activeGM) { status.textContent = "An active GM is required to continue this sale."; for (const button of actions.querySelectorAll("button")) button.disabled = false; return; }
    try {
      await ChatMessage.create({ content: "", whisper: [activeGM.id], flags: { [MODULE_ID]: { saleResponse: { requestId: offer.requestId, ...response } } } });
      close();
    } catch (error) {
      console.error(`${MODULE_ID} | Could not send sale response.`, error);
      status.textContent = "Your response could not be sent to the GM.";
      for (const button of actions.querySelectorAll("button")) button.disabled = false;
    }
  };
  accept.addEventListener("click", () => void send({ action: "accept" }));
  decline.addEventListener("click", () => void send({ action: "decline" }));
  persuade.addEventListener("click", async () => {
    persuade.disabled = true;
    status.textContent = "Rolling Persuasion…";
    const actor = game.user.character;
    if (!actor || actor.id !== offer.buyerId) {
      status.textContent = "Your assigned character changed. Reopen the shop offer using the character who submitted the items.";
      persuade.disabled = false;
      return;
    }
    const skill = actor?.system.skills?.per;
    const ability = actor?.system.abilities?.[skill?.ability ?? "cha"];
    const prof = Number(actor?.system.attributes?.prof ?? 0);
    const proficiency = Number(skill?.value ?? 0);
    const skillBonus = Number(skill?.total ?? skill?.mod ?? (Number(ability?.mod ?? 0) + prof * proficiency));
    const bonusValue = Number(offer.persuasionBonus) || 0;
    try {
      const roll = await new Roll(`1d20 + (${skillBonus}) + (${bonusValue})`).evaluate();
      const rollMessage = await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor }), flavor: `Persuasion to negotiate with ${offer.merchantName}` });
      await rollMessage.update({ [`flags.${MODULE_ID}.persuasionRoll`]: { requestId: offer.requestId, actorId: actor.id } });
      const activeGM = game.users.activeGM;
      if (!activeGM) throw new Error("No active GM is connected.");
      await ChatMessage.create({ content: "", whisper: [activeGM.id], flags: { [MODULE_ID]: { saleResponse: { requestId: offer.requestId, action: "persuade", rollMessageId: rollMessage.id } } } });
      close();
    } catch (error) {
      console.error(`${MODULE_ID} | Persuasion roll failed.`, error);
      status.textContent = "The Persuasion roll could not be sent. You can accept or decline the offer.";
      persuade.disabled = false;
    }
  });
  overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
  overlay.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
}
async function processSaleResponse(response, authenticatedUserId) {
  const sale = pendingSales.get(response.requestId);
  if (!sale || authenticatedUserId !== sale.requesterId) return;
  if (response.action === "decline") {
    pendingSales.delete(response.requestId);
    return saleResultToPlayer(sale.requesterId, response.requestId, { success: false, message: "You declined the merchant's offer." });
  }
  if (response.action === "accept") {
    const result = await commitSale(sale);
    pendingSales.delete(response.requestId);
    await saleResultToPlayer(sale.requesterId, response.requestId, result);
    if (result.success) {
      const escape = value => foundry.utils.escapeHTML(String(value ?? ""));
      const lines = sale.currentOffer.lines.map(line => `${line.quantity} × ${escape(sale.items.find(item => item.itemId === line.itemId)?.name)} — ${escape(goldText(line.offerCopper * line.quantity))}`).join("<br>");
      const gmIds = game.users.filter(user => user.isGM).map(user => user.id);
      void ChatMessage.create({ content: `<div class="merchant-purchase-card"><h3>Merchant Sale</h3><p><strong>${escape(sale.buyer.name)}</strong> sold to ${escape(sale.merchant.name)}:<br>${lines}<br>Total paid: ${escape(goldText(sale.currentOffer.lines.reduce((sum, line) => sum + line.offerCopper * line.quantity, 0)))}</p></div>`, whisper: gmIds }).catch(error => console.error(`${MODULE_ID} | Could not create sale chat card.`, error));
    }
    return;
  }
  if (response.action !== "persuade" || sale.persuasionUsed) return;
  const rollMessage = game.messages.get(response.rollMessageId);
  const rollAuthorId = rollMessage?.author?.id ?? rollMessage?.user?.id;
  const rollTotal = rollMessage?.rolls?.[0]?.total;
  const rollFlag = rollMessage?.getFlag(MODULE_ID, "persuasionRoll");
  if (!rollMessage || rollAuthorId !== authenticatedUserId || rollMessage.speaker?.actor !== sale.buyer.id || rollFlag?.requestId !== response.requestId || rollFlag?.actorId !== sale.buyer.id || !Number.isFinite(rollTotal)) {
    return sendSaleOffer(sale, { outcome: "The Persuasion roll could not be verified. The current offer remains open.", persuasionUsed: false });
  }
  const insight = sale.merchant.system.skills?.ins;
  const wisdom = sale.merchant.system.abilities?.wis;
  const proficiency = Number(sale.merchant.system.attributes?.prof ?? 0);
  const insightBonus = Number(insight?.total ?? insight?.mod ?? (Number(wisdom?.mod ?? 0) + proficiency * Number(insight?.value ?? 0)));
  const insightRoll = await new Roll(`1d20 + (${insightBonus})`).evaluate();
  await insightRoll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: sale.merchant }), flavor: `Insight contest against ${sale.buyer.name}'s Persuasion`, whisper: game.users.filter(user => user.isGM).map(user => user.id) });
  sale.persuasionUsed = true;
  if (rollTotal > insightRoll.total) {
    const rollSummary = `${sale.buyer.name} Persuasion: ${rollTotal}. ${sale.merchant.name} Insight: ${insightRoll.total}. The character won and may receive a revised offer.`;
    const revised = await promptGmSaleOffer(sale, { previous: sale.currentOffer, rollSummary });
    if (revised && !revised.keep) { sale.currentOffer = revised; sale.persuasionBonus = revised.persuasionBonus; }
    await sendSaleOffer(sale, { outcome: rollSummary, persuasionUsed: true });
  } else {
    const rollSummary = `${sale.buyer.name} Persuasion: ${rollTotal}. ${sale.merchant.name} Insight: ${insightRoll.total}. The merchant held firm; the offer is unchanged.`;
    await sendSaleOffer(sale, { outcome: rollSummary, persuasionUsed: true });
  }
}
async function commitSale(sale) {
  const { buyer, merchant, currentOffer } = sale;
  if (!isConfiguredShop(merchant)) return { success: false, message: "This merchant is no longer set up as a shop." };
  const total = currentOffer.lines.reduce((sum, line) => sum + line.offerCopper * line.quantity, 0);
  const buyerCurrency = foundry.utils.deepClone(buyer.system.currency ?? {}), merchantCurrency = foundry.utils.deepClone(merchant.system.currency ?? {});
  if (copperValue(merchantCurrency) < total) return { success: false, message: "The merchant no longer has enough funds to pay this offer." };
  const stock = foundry.utils.deepClone(merchant.getFlag(MODULE_ID, "stock") ?? []), originalStock = foundry.utils.deepClone(stock);
  const itemChanges = [], fullItems = [], soldRecords = [];
  for (const line of currentOffer.lines) {
    const item = buyer.items.get(line.itemId), quantity = Math.floor(Number(line.quantity)), record = sale.items.find(candidate => candidate.itemId === line.itemId);
    if (!item || !record || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > itemQuantity(item)) return { success: false, message: `${record?.name ?? "An item"} is no longer available in the requested quantity.` };
    const data = item.toObject(); delete data._id; delete data._stats; delete data.uuid;
    const remaining = itemQuantity(item) - quantity;
    if (remaining) itemChanges.push({ _id: item.id, "system.quantity": remaining });
    else fullItems.push(item);
    soldRecords.push({ item, data, quantity, originalQuantity: itemQuantity(item) });
  }
  for (const { item, data, quantity } of soldRecords) {
    let entry = stock.find(candidate => candidate.sourceUuid === item.uuid || (!candidate.sourceUuid && candidate.name === item.name && candidate.type === item.type));
    if (entry) {
      entry.quantity = Number(entry.quantity ?? 0) + quantity;
      entry.system ??= {};
      entry.system.price = foundry.utils.deepClone(data.system?.price ?? {});
    } else stock.push({ id: foundry.utils.randomID(), name: item.name, img: item.img, type: item.type, system: foundry.utils.deepClone(data.system ?? {}), sourceUuid: item.uuid, sourceData: data, quantity });
  }
  let buyerMoneyAttempted = false, merchantUpdateAttempted = false;
  try {
    if (itemChanges.length) await buyer.updateEmbeddedDocuments("Item", itemChanges);
    if (fullItems.length) await buyer.deleteEmbeddedDocuments("Item", fullItems.map(item => item.id));
    buyerMoneyAttempted = true;
    await buyer.update({ "system.currency": currencyFromCopper(copperValue(buyerCurrency) + total) });
    merchantUpdateAttempted = true;
    await merchant.update({ "system.currency": currencyFromCopper(copperValue(merchantCurrency) - total), [`flags.${MODULE_ID}.stock`]: stock });
  return { success: true, message: `The merchant paid you ${goldText(total)} for your items.` };
  } catch (error) {
    console.error(`${MODULE_ID} | Sale transaction failed.`, error);
    try {
      if (merchantUpdateAttempted) await merchant.update({ "system.currency": merchantCurrency, [`flags.${MODULE_ID}.stock`]: originalStock });
      if (buyerMoneyAttempted) await buyer.update({ "system.currency": buyerCurrency });
      const deletedSources = soldRecords.filter(record => fullItems.some(item => item.id === record.item.id) && !buyer.items.has(record.item.id)).map(record => record.data);
      if (deletedSources.length) await buyer.createEmbeddedDocuments("Item", deletedSources);
      const partialRestores = soldRecords.filter(record => itemChanges.some(change => change._id === record.item.id) && buyer.items.has(record.item.id));
      if (partialRestores.length) await buyer.updateEmbeddedDocuments("Item", partialRestores.map(record => ({ _id: record.item.id, "system.quantity": record.originalQuantity })));
    } catch (rollbackError) { console.error(`${MODULE_ID} | Sale rollback also failed.`, rollbackError); }
    return { success: false, message: `The sale could not be completed: ${error.message ?? error}. Check with the GM before retrying.` };
  }
}
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class MerchantOfferSheet extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(sale, previous, rollSummary) {
    super({ id: `merchant-offer-${sale.request.requestId}` });
    this.sale = sale;
    this.previous = previous;
    this.rollSummary = rollSummary;
    this.settled = false;
    this.result = new Promise(resolve => { this.resolveResult = resolve; });
  }
  static DEFAULT_OPTIONS = {
    id: "merchant-offer", tag: "form", classes: ["merchant-npc", "merchant-offer-sheet"],
    window: { title: "Merchant Offer", resizable: true }, position: { width: 780, height: 650 },
    actions: { cancel: MerchantOfferSheet.#cancel, submit: MerchantOfferSheet.#submit }
  };
  static PARTS = { form: { template: "modules/merchant-npc/templates/merchant-offer-sheet.hbs" } };
  get title() { return `Offer to ${this.sale.buyer.name}`; }
  async _prepareContext() {
    const previousLines = new Map((this.previous?.lines ?? []).map(line => [line.itemId, line]));
    return {
      characterName: this.sale.buyer.name,
      merchantName: this.sale.merchant.name,
      rollSummary: this.rollSummary,
      hasRollSummary: Boolean(this.rollSummary),
      funds: currencyText(this.sale.merchant.system.currency ?? {}),
      fundsTotal: goldText(copperValue(this.sale.merchant.system.currency ?? {})),
      items: this.sale.items.map(record => {
        const oldLine = previousLines.get(record.itemId);
        return {
          ...record,
          selected: this.previous ? Boolean(oldLine) : true,
          offerGp: ((oldLine?.offerCopper ?? record.unitValueCopper ?? 0) / CURRENCY.gp).toFixed(2),
          valueTotal: record.unitValueCopper === null ? "" : ` each; ${copperText(record.unitValueCopper * record.quantity)} total`
        };
      }),
      persuasionBonus: this.previous?.persuasionBonus ?? this.sale.persuasionBonus ?? 0,
      keepLabel: this.previous ? "Keep Current Offer" : "Cancel Sale",
      submitLabel: this.previous ? "Send Revised Offer" : "Send Offer"
    };
  }
  _onRender(context, options) {
    super._onRender?.(context, options);
    const calculate = () => {
      let offerTotal = 0, valid = true, selected = 0;
      for (const row of this.element.querySelectorAll(".merchant-gm-sale-line")) {
        const checkbox = row.querySelector("[name='includeItem']"), amountInput = row.querySelector("[name='offerGp']");
        if (!checkbox?.checked) continue;
        selected++;
        const amount = Number(amountInput?.value);
        const lineCopper = Math.round(amount * CURRENCY.gp);
        if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(lineCopper)) { valid = false; continue; }
        offerTotal += lineCopper * Number(row.dataset.quantity);
      }
      if (!Number.isSafeInteger(offerTotal)) valid = false;
      const total = this.element.querySelector(".merchant-sale-total");
      const status = this.element.querySelector(".merchant-sale-status");
      const submit = this.element.querySelector("[data-action='submit']");
      const purse = copperValue(this.sale.merchant.system.currency ?? {});
      if (total) total.textContent = `Total offer: ${goldText(offerTotal)}`;
      if (status) status.textContent = !selected ? "Select at least one item to make an offer." : !valid ? "Enter valid non-negative offers." : offerTotal > purse ? "The merchant does not have enough funds for this offer." : `${this.sale.buyer.name} will be asked to accept or negotiate this offer.`;
      if (submit) submit.disabled = !selected || !valid || offerTotal > purse;
    };
    this.element.querySelectorAll(".merchant-gm-sale-line input, [name='persuasionBonus']").forEach(input => {
      input.addEventListener("input", calculate);
      input.addEventListener("change", calculate);
    });
    calculate();
  }
  finish(result) {
    if (this.settled) return;
    this.settled = true;
    this.resolveResult(result);
    if (this.rendered) void this.close();
  }
  _onClose(options) {
    if (!this.settled) { this.settled = true; this.resolveResult(null); }
    return super._onClose?.(options);
  }
  static async #cancel() { this.finish(this.previous ? { keep: true } : null); }
  static async #submit() {
    const lines = [];
    for (const row of this.element.querySelectorAll(".merchant-gm-sale-line")) {
      if (!row.querySelector("[name='includeItem']")?.checked) continue;
      const offerCopper = Math.round(Number(row.querySelector("[name='offerGp']")?.value) * CURRENCY.gp);
      lines.push({ itemId: row.dataset.itemId, quantity: Number(row.dataset.quantity), offerCopper });
    }
    const persuasionBonus = Number(this.element.querySelector("[name='persuasionBonus']")?.value ?? 0);
    if (!lines.length || !Number.isSafeInteger(persuasionBonus)) return;
    this.finish({ lines, persuasionBonus });
  }
}

class SellItemsSheet extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, merchant) {
    super({ id: `merchant-sell-items-${merchant.id}-${actor.id}` });
    this.actor = actor;
    this.merchant = merchant;
    this.staged = new Map();
  }
  static DEFAULT_OPTIONS = {
    id: "merchant-sell-items", tag: "form", classes: ["merchant-npc", "merchant-sell-sheet"],
    window: { title: "Sell Items", resizable: true }, position: { width: 640, height: 500 },
    actions: { removeItem: SellItemsSheet.#removeItem, cancel: SellItemsSheet.#cancel, submit: SellItemsSheet.#submit }
  };
  static PARTS = { form: { template: "modules/merchant-npc/templates/sell-items-sheet.hbs" } };
  async _prepareContext() {
    return {
      actor: this.actor,
      merchant: this.merchant,
      items: [...this.staged.values()].map(record => ({
        id: record.item.id, name: record.item.name, img: record.item.img,
        quantity: record.quantity, available: record.available,
        valueText: itemPriceCopper(record.item) === null ? "Value not set" : `Value ${priceLabel(record.item.system?.price ?? {})} each`
      })),
      hasItems: this.staged.size > 0
    };
  }
  _onRender(context, options) {
    super._onRender?.(context, options);
    const dropArea = this.element.querySelector(".merchant-sale-drop-area");
    if (!dropArea) return;
    dropArea.addEventListener("dragover", event => { event.preventDefault(); dropArea.classList.add("drag-active"); });
    dropArea.addEventListener("dragleave", () => dropArea.classList.remove("drag-active"));
    dropArea.addEventListener("drop", async event => {
      event.preventDefault(); dropArea.classList.remove("drag-active");
      let data;
      try { data = TextEditor.getDragEventData(event); } catch { data = null; }
      if (data?.type !== "Item" || !data.uuid) return ui.notifications.warn("Drop an item from your character's inventory.");
      const item = await fromUuid(data.uuid).catch(() => null);
      if (!item || item.parent?.id !== this.actor.id || !this.actor.items.has(item.id)) return ui.notifications.warn("Only items in your assigned character's inventory can be sold.");
      const available = itemQuantity(item);
      if (!available) return ui.notifications.warn(`${item.name} has no sellable quantity.`);
      const existing = this.staged.get(item.id);
      this.staged.set(item.id, { item, available, quantity: Math.min(available, (existing?.quantity ?? 0) + 1) });
      this.render();
    });
    for (const input of this.element.querySelectorAll("[name='sellQuantity']")) input.addEventListener("change", () => {
      const record = this.staged.get(input.dataset.id);
      if (!record) return;
      record.quantity = Math.max(1, Math.min(record.available, Math.floor(Number(input.value) || 1)));
      input.value = String(record.quantity);
    });
  }
  static async #removeItem(_event, target) {
    this.staged.delete(target.dataset.id);
    this.render();
  }
  static async #cancel() { this.close(); }
  static async #submit() {
    if (!this.staged.size) return;
    const items = [...this.staged.values()].map(record => ({ itemId: record.item.id, quantity: record.quantity }));
    await this.close();
    await requestSale(this.actor, this.merchant, items);
  }
}

class MerchantSheet extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(actor, options = {}) {
    super({ ...options, id: `merchant-npc-${actor.id}` });
    this.actor = actor;
    this.shopType = actor.getFlag(MODULE_ID, "shopType") ?? "general";
  }
  static DEFAULT_OPTIONS = {
    id: "merchant-npc", tag: "form", classes: ["merchant-npc"], window: { title: "Merchant Shop", resizable: true }, position: { width: 1000, height: 720 },
    form: { handler: MerchantSheet.#onSubmit, submitOnChange: false },
    actions: { addItems: MerchantSheet.#addItems, removeItem: MerchantSheet.#removeItem, saveItem: MerchantSheet.#saveItem, buy: MerchantSheet.#buy, sellItems: MerchantSheet.#sellItems, setFloat: MerchantSheet.#setFloat, setShopType: MerchantSheet.#setShopType }
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
        return { ...item, hasPrice, priceMissing: !hasPrice, priceZero: !hasPrice || Number(price.value) === 0, priceText: hasPrice ? priceLabel(price) : "Price not set", denomination: price?.denomination ?? "gp", description: tooltipText(item.system?.description?.value ?? item.system?.description ?? "") };
      }),
      isGM: game.user.isGM,
      shopTypeLabel: SHOP_TYPES[this.shopType] ?? SHOP_TYPES.general,
      shopType: this.shopType,
      shopTypeOptions: Object.entries(SHOP_TYPES).map(([value, label]) => ({ value, label, selected: value === this.shopType })),
      funds: this.#funds(),
      floatPresets: FLOAT_PRESETS.map(([name, amount]) => {
        const multiplier = this.shopType === "jeweller" ? 10 : 1;
        return { value: amount, label: `${name} · ${(amount * multiplier).toLocaleString()} gp` };
      }),
      floatHint: this.shopType === "jeweller" ? "Jeweller starting floats multiply preset and custom amounts by ten." : "Choose a starting purse in gold pieces."
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
    const selectedType = this.element.querySelector("[name='shopType']")?.value;
    const savedType = this.actor.getFlag(MODULE_ID, "shopType");
    this.shopType = SHOP_TYPES[selectedType] ? selectedType : (SHOP_TYPES[savedType] ? savedType : "general");
    const preset = this.element.querySelector("[name='floatPreset']")?.value;
    const custom = Number(this.element.querySelector("[name='floatAmount']")?.value);
    const baseGp = preset === "custom" ? custom : Number(preset);
    if (!Number.isFinite(baseGp) || baseGp < 0) return ui.notifications.warn("Choose a valid float preset or enter a non-negative custom amount in gold pieces.");
    const gp = baseGp * (this.shopType === "jeweller" ? 10 : 1);
    let balance = Math.round(gp * CURRENCY.gp);
    const currency = {};
    for (const [denomination, value] of Object.entries(CURRENCY)) { currency[denomination] = Math.floor(balance / value); balance %= value; }
    await this.actor.setFlag(MODULE_ID, "shopType", this.shopType);
    await this.actor.setFlag(MODULE_ID, "isShop", true);
    await this.actor.update({ "system.currency": currency });
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
  static async #sellItems() {
    const buyer = game.user.character;
    if (!buyer) return ui.notifications.warn("Assign your user a character in User Configuration before selling items.");
    const characterSheet = buyer.sheet;
    if (characterSheet && !characterSheet.rendered) {
      try {
        await characterSheet.render(true);
      } catch (error) {
        console.warn(`${MODULE_ID} | Could not open the character sheet before selling items.`, error);
      }
    }
    const sheet = new SellItemsSheet(buyer, this.actor);
    void sheet.render(true).then(() => {
      const bounds = sheet.element?.getBoundingClientRect();
      if (!bounds) return;
      sheet.setPosition({
        left: Math.max(0, (window.innerWidth - bounds.width) / 2),
        top: Math.max(0, (window.innerHeight - bounds.height) / 2)
      });
    }).catch(error => {
      console.error(`${MODULE_ID} | Could not open the sell items sheet.`, error);
      ui.notifications.error("The sell items sheet could not be opened.");
    });
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
    const worldItems = game.items.contents.map(item => ({ _id: item.id, name: item.name, img: item.img, type: item.type, category: classifyItem(item), description: tooltipText(item.system?.description?.value ?? item.system?.description ?? ""), source: "world-items" })).filter(item => item.category);
    indexedCatalog = worldItems.length ? [{ id: "world-items", label: "World Items", items: worldItems, world: true }] : [];
    this.catalog = indexedCatalog;
    if (!indexingCatalog) {
      const packs = game.packs.filter(candidate => candidate.documentName === "Item");
      indexingCatalog = mapWithConcurrency(packs, 4, async pack => {
        try {
          const source = await withTimeout((async () => {
            await pack.getIndex({ fields: ["system.type.value", "system.armor", "system.rarity", "system.attunement", "system.properties", "system.magical", "system.identifier", "system.description.value", "system.description"] });
            const items = [...pack.index].map(entry => ({ _id: entry._id, name: entry.name, img: entry.img, type: entry.type, category: classifyItem(entry), description: tooltipText(entry.system?.description?.value ?? entry.system?.description ?? ""), source: pack.collection })).filter(item => item.category);
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
    const matchingSources = [];
    for (const source of sources) {
      let matchingCount = 0;
      for (const item of source.items) if (this.selectedTypes.has(item.category)) matchingCount++;
      if (matchingCount) matchingSources.push({ source, matchingCount });
    }
    if (this.selectedSources === null && this.selectedTypes.size) this.selectedSources = new Set(matchingSources.map(({ source }) => source.id));
    if (this.selectedSources) {
      const sourceIds = new Set(sources.map(source => source.id));
      this.selectedSources = new Set([...this.selectedSources].filter(id => sourceIds.has(id)));
    }
    const sourceOptions = matchingSources.map(({ source, matchingCount }) => ({ id: source.id, label: source.label, count: matchingCount, checked: this.selectedSources.has(source.id) }));
    const query = this.search.trim().toLowerCase();
    const typeLabels = new Map(ITEM_CATEGORIES);
    const sourceLabels = new Map(sources.map(source => [source.id, source.label]));
    this.visibleItems = [];
    for (const { source } of matchingSources) {
      if (!this.selectedSources?.has(source.id)) continue;
      for (const item of source.items) {
        if (!this.selectedTypes.has(item.category) || (query && !item.name.toLowerCase().includes(query))) continue;
        this.visibleItems.push({ ...item, typeLabel: typeLabels.get(item.category) ?? item.type, sourceLabel: sourceLabels.get(item.source) ?? item.source });
      }
    }
    this.visibleItems.sort((a, b) => a.name.localeCompare(b.name));
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
    let completedDraws = 0;
    let skippedResults = 0;
    for (let i = 0; i < draws; i++) {
      let draw;
      try {
        draw = await table.draw({ displayChat: false, recursive: true });
      } catch (error) {
        // Tables configured without replacement can run out of undrawn results
        // before the requested number of draws has been reached.
        console.debug(`${MODULE_ID} | Stopped drawing from '${table.name}' after ${completedDraws} result${completedDraws === 1 ? "" : "s"}.`, error);
        break;
      }
      completedDraws += 1;
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
        else skippedResults += 1;
      }
    }
    if (items.length) {
      await this.merchantSheet.addStockMany(items.map(source => ({ source, quantity: 1 })));
      const skippedMessage = skippedResults ? ` Skipped ${skippedResults} result${skippedResults === 1 ? "" : "s"} that did not match the selected item types or link to an Item.` : "";
      const exhaustedMessage = completedDraws < draws ? ` The table had only ${completedDraws} available draw${completedDraws === 1 ? "" : "s"}.` : "";
      ui.notifications.info(`Added ${items.length} item result${items.length === 1 ? "" : "s"} from ${table.name}.${skippedMessage}${exhaustedMessage}`);
    }
    else if (completedDraws === 0) ui.notifications.warn("There are no available results which can be drawn from this table. Reset the table results or enable drawing with replacement.");
    else ui.notifications.warn("The selected table returned no matching linked Item documents. Link its results to Item documents that match the selected item types.");
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
