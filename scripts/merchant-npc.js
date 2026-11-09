const MODULE_ID = "merchant-npc";
const CURRENCY = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };
const FLOAT_PRESETS = [["Poor", 200], ["Average", 500], ["Rich", 1000]];
const SHOP_TYPES = { general: "Standard Merchant", jeweller: "Jeweller" };
const ITEM_CATEGORIES = [
  ["potions", "Potions"], ["weapons", "Weapons"], ["armour", "Armour"],
  ["magic", "Magic Items"], ["equipment", "Normal Equipment"]
];
const pendingPurchases = new Map();
const basketItemApprovals = new Map();
const processingApprovals = new Set();
const pendingSales = new Map();
const activeCartCounts = new Map();
const pendingCartRefreshes = new Set();
const cachedSourceItemData = new Map();
const catalogSubscribers = new Set();
const merchantSheetSubscribers = new Set();
let catalogRefreshPending = false;
// Keep the indexed catalog for this client session so reopening Add Items does
// not repeat compendium indexing and item/description classification.
let indexedCatalog = null;
let indexingCatalog = null;
let indexedRollTableCatalog = null;
let indexingRollTableCatalog = null;

function cartCountKey(merchantUuid, stockId, userId) { return `${merchantUuid}|${stockId}|${userId}`; }
function refreshMerchantSheets(merchantUuid) {
  for (const sheet of merchantSheetSubscribers) {
    if (sheet.actor.uuid !== merchantUuid || !sheet.element?.isConnected) continue;
    sheet._restoreShopScrollTop = sheet.element.querySelector(".merchant-layout")?.scrollTop ?? 0;
    sheet.render();
  }
}
function scheduleCartRefresh(merchantUuid) {
  if (pendingCartRefreshes.has(merchantUuid)) return;
  pendingCartRefreshes.add(merchantUuid);
  requestAnimationFrame(() => {
    pendingCartRefreshes.delete(merchantUuid);
    refreshMerchantSheets(merchantUuid);
  });
}
function applyCartCount({ merchantUuid, stockId, userId, quantity, expiresAt }) {
  if (!merchantUuid || !stockId || !userId || !game.users.get(userId)) return;
  const key = cartCountKey(merchantUuid, stockId, userId);
  const previous = activeCartCounts.get(key);
  if (previous) window.clearTimeout(previous.timer);
  const count = Math.floor(Number(quantity));
  const now = Date.now();
  const expiry = Math.min(Number(expiresAt), now + 120000);
  if (Number.isSafeInteger(count) && count > 0 && expiry > now) {
    const timer = window.setTimeout(() => {
      activeCartCounts.delete(key);
      scheduleCartRefresh(merchantUuid);
    }, expiry - now);
    activeCartCounts.set(key, { merchantUuid, stockId, quantity: count, expiresAt: expiry, timer });
  } else activeCartCounts.delete(key);
  scheduleCartRefresh(merchantUuid);
}
function publishCartCount(merchantUuid, stockId, quantity) {
  const payload = { type: "cart-count", merchantUuid, stockId, userId: game.user.id, quantity, expiresAt: Date.now() + 120000 };
  applyCartCount(payload);
  game.socket.emit(`module.${MODULE_ID}`, payload);
}
function getCartQuantity(merchantUuid, stockId) {
  let total = 0;
  const now = Date.now();
  for (const cart of activeCartCounts.values()) {
    if (cart.expiresAt > now && cart.merchantUuid === merchantUuid && cart.stockId === stockId) total += cart.quantity;
  }
  return total;
}

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
function isMonsterActor(actor) {
  const source = actor?._stats?.compendiumSource ?? actor?.getFlag("core", "sourceId") ?? "";
  return /monster/i.test(source);
}
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
  if (tokenActor?.getFlag(MODULE_ID, "isShop") !== undefined) return tokenActor;
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
  // Feats include D&D 5e class features; they are not shop inventory items.
  if (["spell", "feat", "class", "subclass"].includes(String(item.type ?? "").toLowerCase())) return null;
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

const PAUSED_SHOP_MESSAGE = "The game is paused. The shop will be available when play resumes.";
function isShopPaused(user = game.user) { return game.paused && !user?.isGM; }

function canShopAs(actor, user) {
  return actor?.type === "character" && actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER);
}

function getSelectedShoppers() {
  const characters = new Set();
  for (const token of canvas.tokens?.controlled ?? []) {
    const actor = token.document.baseActor;
    if (canShopAs(actor, game.user)) characters.add(actor);
  }
  return [...characters];
}

Hooks.once("ready", () => {
  game.socket.on(`module.${MODULE_ID}`, payload => {
    if (payload?.type === "cart-count" && payload.userId !== game.user.id) applyCartCount(payload);
  });
  Hooks.on("pauseGame", paused => {
    if (!paused || game.user.isGM) return;
    for (const sheet of merchantSheetSubscribers) void sheet.close();
  });
  const openingShops = new Set();
  const openShop = async (actor) => {
    if (isShopPaused()) return ui.notifications.warn(PAUSED_SHOP_MESSAGE);
    if (actor?.type !== "npc") return ui.notifications.warn("Merchant NPC could not be found.");
    if (openingShops.has(actor.uuid)) return null;
    let shopper;
    if (!game.user.isGM) {
      const shoppers = getSelectedShoppers();
      if (shoppers.length !== 1) {
        ui.notifications.warn("Select the token for one character you own before opening the shop.");
        return null;
      }
      [shopper] = shoppers;
    }
    openingShops.add(actor.uuid);
    try {
      if (game.user.isGM) await actor.setFlag(MODULE_ID, "isShop", true);
      if (!isConfiguredShop(actor)) return null;
      if (isShopPaused()) return null;
      const sheet = [...merchantSheetSubscribers].find(open => open.actor.uuid === actor.uuid && open.rendered)
        ?? new MerchantSheet(actor);
      if (sheet.shopperId !== shopper?.id) sheet.resetBasket();
      sheet.shopperId = shopper?.id;
      await sheet.render(true);
      if (isShopPaused()) {
        await sheet.close();
        return null;
      }
      return sheet;
    } catch (error) {
      console.error(`${MODULE_ID} | Could not open merchant shop`, { actor: actor?.name, error });
      ui.notifications.error(`Could not open ${actor.name}'s shop. Check the browser console for Merchant NPC details.`);
      return null;
    } finally {
      openingShops.delete(actor.uuid);
    }
  };
  game.merchantNPC = { open: actor => game.user.isGM ? openShop(actor) : null };
  const installTokenShopControls = () => {
    const tokenLayer = canvas.tokens?.constructor;
    const tokenLayerPrototype = tokenLayer?.prototype;
    if (!tokenLayerPrototype?._onClickLeft2 || tokenLayerPrototype._merchantNPCWrapped) return;
    const isShopToken = token => token?.isVisible && !token.document.hidden && isConfiguredShop(getConfiguredShopActor(token));
    const openTokenShop = (token, event) => {
      if (game.user.isGM || !isShopToken(token)) return false;
      event?.stopPropagation?.();
      void openShop(getConfiguredShopActor(token));
      return true;
    };
    const keepShopperSelected = (token, event) => !game.user.isGM
      && !event?.shiftKey && !event?.ctrlKey && !event?.altKey && !event?.metaKey
      && isShopToken(token) && getSelectedShoppers().length > 0;
    const tokenPrototype = tokenLayer.placeableClass?.prototype;
    const tokenClick = tokenPrototype?._onClickLeft;
    if (tokenClick) tokenPrototype._onClickLeft = function(event, ...args) {
      if (!keepShopperSelected(this, event)) return tokenClick.call(this, event, ...args);
      event?.stopPropagation?.();
    };
    const tokenDoubleClick = tokenPrototype?._onClickLeft2;
    if (tokenDoubleClick) tokenPrototype._onClickLeft2 = function(event, ...args) {
      if (!openTokenShop(this, event)) return tokenDoubleClick.call(this, event, ...args);
    };
    // A token the player cannot control can leave the click to the canvas layer.
    const getClickedToken = (layer, event) => {
      for (let target = event?.target; target; target = target.parent) {
        if (target.document?.documentName === "Token") return target;
      }
      if (!event?.getLocalPosition) return null;
      return [...layer.placeables].reverse().find(token => {
        if (!token.isVisible || token.document.hidden) return false;
        const { x, y } = event.getLocalPosition(token);
        return token.getShape().contains(x, y);
      });
    };
    const layerClick = tokenLayerPrototype._onClickLeft;
    if (layerClick) tokenLayerPrototype._onClickLeft = function(event, ...args) {
      if (game.user.isGM || !keepShopperSelected(getClickedToken(this, event), event)) return layerClick.call(this, event, ...args);
      event?.stopPropagation?.();
    };
    const layerDoubleClick = tokenLayerPrototype._onClickLeft2;
    tokenLayerPrototype._onClickLeft2 = function(event, ...args) {
      if (game.user.isGM || !openTokenShop(getClickedToken(this, event), event)) return layerDoubleClick.call(this, event, ...args);
    };
    tokenLayerPrototype._merchantNPCWrapped = true;
    console.info(`${MODULE_ID} | Token shop controls installed.`);
  };
  Hooks.on("canvasReady", installTokenShopControls);
  installTokenShopControls();
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
        if (pending?.currentOffer) await sendSaleOffer(pending, { outcome: "The negotiation could not be processed; the current offer still stands.", persuasionUsed: pending.persuasionUsed });
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
        try {
          await resolvePurchaseApproval(message, approval.requestId, approve);
        } catch (error) {
          console.error(`${MODULE_ID} | Could not finish processing purchase approval.`, error);
          ui.notifications.error("Could not finish processing the approval. Check the character inventory and merchant stock.");
        }
      }, { once: true });
    }
  });
  Hooks.on("updateActor", actor => {
    for (const sheet of merchantSheetSubscribers) {
      if (sheet.actor.id !== actor.id || !sheet.element?.isConnected) continue;
      if (!isConfiguredShop(sheet.actor)) void sheet.close();
      else if (sheet.actor.uuid === actor.uuid) {
        sheet._restoreShopScrollTop = sheet.element.querySelector(".merchant-layout")?.scrollTop ?? 0;
        sheet.render();
      }
    }
  });
  Hooks.on("getActorDirectoryEntryContext", (_html, entries) => entries.push({
    name: "Open Merchant Shop", icon: '<i class="fas fa-store"></i>',
    condition: (li) => game.user.isGM && isConfiguredShop(game.actors.get(li.data("documentId"))),
    callback: (li) => game.merchantNPC.open(game.actors.get(li.data("documentId")))
  }));
  Hooks.on("getActorDirectoryEntryContext", (_html, entries) => entries.push({
    name: "Set Up Merchant Shop", icon: '<i class="fas fa-store"></i>',
    condition: (li) => game.user.isGM && game.actors.get(li.data("documentId"))?.type === "npc" && !isConfiguredShop(game.actors.get(li.data("documentId"))),
    callback: (li) => game.merchantNPC.open(game.actors.get(li.data("documentId")))
  }));
  const addMerchantButton = (app, html) => {
    const actor = app.actor ?? app.document;
    if (!game.user.isGM || actor?.type !== "npc") return;
    const configuredShop = isConfiguredShop(actor);
    if (!configuredShop && isMonsterActor(actor)) return;
    const root = html instanceof HTMLElement ? html : html?.[0];
    const header = root?.querySelector(".window-header");
    if (!header || header.querySelector(".merchant-open")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "header-control merchant-open";
    button.innerHTML = '<i class="fas fa-store" aria-hidden="true"></i>';
    button.setAttribute("aria-label", configuredShop ? "Open merchant shop" : "Set up merchant shop");
    button.title = configuredShop ? "Open merchant shop" : "Set up merchant shop";
    button.addEventListener("click", (event) => { event.preventDefault(); game.merchantNPC.open(actor); });
    const controlsMenu = app.window?.controls
      ?? header.querySelector("button[data-action='toggleControls'], .window-controls button:first-of-type");
    if (controlsMenu?.parentElement) controlsMenu.after(button);
    else header.append(button);
  };
  Hooks.on("renderActorSheetV2", addMerchantButton);
  Hooks.on("renderActorSheet", addMerchantButton);
});

function copperValue(currency = {}) { return Object.entries(CURRENCY).reduce((total, [key, value]) => total + Number(currency[key] ?? 0) * value, 0); }
function transactionDenomination(denomination, amountCopper) {
  const keys = Object.keys(CURRENCY);
  let index = keys.indexOf(String(denomination ?? "gp").toLowerCase());
  if (index < 0) throw new Error(`Unknown currency denomination: ${denomination}`);
  while (index < keys.length - 1 && amountCopper % CURRENCY[keys[index]] !== 0) index++;
  if (amountCopper % CURRENCY[keys[index]] !== 0) throw new Error("Transaction amount cannot be represented in the available coin denominations.");
  return keys[index];
}
function addCurrencyForTransaction(currency = {}, amountCopper, denomination = "gp") {
  const result = Object.fromEntries(Object.keys(CURRENCY).map(key => {
    const value = Number(currency[key] ?? 0);
    return [key, Number.isSafeInteger(value) && value > 0 ? value : 0];
  }));
  const start = Object.keys(CURRENCY).indexOf(String(denomination ?? "gp").toLowerCase());
  if (start < 0) throw new Error(`Unknown currency denomination: ${denomination}`);
  let remaining = amountCopper;
  for (const key of Object.keys(CURRENCY).slice(start)) {
    result[key] += Math.floor(remaining / CURRENCY[key]);
    remaining %= CURRENCY[key];
  }
  if (remaining) throw new Error("Transaction amount cannot be represented in the available coin denominations.");
  return result;
}
function deductCurrencyForTransaction(currency = {}, amountCopper, denomination = "gp") {
  const result = Object.fromEntries(Object.keys(CURRENCY).map(key => {
    const value = Number(currency[key] ?? 0);
    return [key, Number.isSafeInteger(value) && value > 0 ? value : 0];
  }));
  const target = transactionDenomination(denomination, amountCopper);
  const denominations = Object.keys(CURRENCY), targetIndex = denominations.indexOf(target), targetValue = CURRENCY[target];
  const unitsNeeded = amountCopper / targetValue;

  // Spend the transaction denomination directly when possible.
  if (result[target] >= unitsNeeded) {
    result[target] -= unitsNeeded;
    return result;
  }

  // If one higher denomination can cover the whole payment, make only the
  // required change in the transaction denomination and preserve the rest.
  const higher = denominations.slice(0, targetIndex).reverse()
    .find(key => result[key] * CURRENCY[key] >= amountCopper);
  if (higher) {
    const coins = Math.ceil(amountCopper / CURRENCY[higher]);
    result[higher] -= coins;
    const change = coins * CURRENCY[higher] - amountCopper;
    result[target] += change / targetValue;
    return result;
  }

  // Otherwise use existing coins at or below the transaction denomination,
  // then combine higher denominations as needed. Any overpayment is returned
  // in the target denomination and smaller coins, preserving unrelated funds.
  let remaining = amountCopper;
  for (const key of denominations.slice(targetIndex)) {
    const coins = Math.min(result[key], Math.floor(remaining / CURRENCY[key]));
    result[key] -= coins;
    remaining -= coins * CURRENCY[key];
    if (!remaining) return result;
  }
  for (const key of denominations.slice(0, targetIndex).reverse()) {
    if (!result[key]) continue;
    const coins = Math.ceil(remaining / CURRENCY[key]);
    if (coins > result[key]) {
      remaining -= result[key] * CURRENCY[key];
      result[key] = 0;
      continue;
    }
    result[key] -= coins;
    let change = coins * CURRENCY[key] - remaining;
    for (const changeKey of denominations.slice(targetIndex)) {
      const changeCoins = Math.floor(change / CURRENCY[changeKey]);
      result[changeKey] += changeCoins;
      change %= CURRENCY[changeKey];
    }
    if (change) throw new Error("Transaction change cannot be represented in the available coin denominations.");
    return result;
  }
  throw new Error("Insufficient funds for this transaction.");
}
function currencyText(currency = {}) {
  const parts = Object.keys(CURRENCY).map(key => [key, Number(currency[key] ?? 0)]).filter(([, amount]) => amount > 0).map(([key, amount]) => `${amount} ${key}`);
  return parts.join(", ") || "0 cp";
}
function copperText(amount) {
  return goldText(amount);
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
function purchasePrice(entry) {
  const price = entry.system?.price ?? {};
  const raw = price.value ?? price.amount;
  if (raw == null || raw === "") return { error: `${entry.name} has no price set.` };
  const denomination = String(price.denomination ?? price.currency ?? "gp").toLowerCase();
  const unitCost = Math.round(Number(raw) * CURRENCY[denomination]);
  if (!Number.isSafeInteger(unitCost) || Number(raw) < 0) return { error: `${entry.name} has an invalid price.` };
  return { denomination, unitCost, isFree: Number(raw) === 0 };
}

function quotePurchase(stock, requested) {
  if (!Array.isArray(requested) || !requested.length) return { error: "Your basket is empty." };
  const entries = new Map(stock.map(entry => [entry.id, entry]));
  const lines = [];
  let total = 0;
  for (const line of requested) {
    const { stockId, quantity, unitCost, denomination, approvalIds } = line ?? {};
    if (!Number.isSafeInteger(quantity) || quantity < 1) return { error: "Choose a valid purchase quantity." };
    const entry = entries.get(stockId);
    if (!entry) return { error: "An item in your basket is no longer for sale. Remove it to continue." };
    entries.delete(stockId);
    if (!(Number(entry.quantity) >= quantity)) return { error: `Only ${Number(entry.quantity) || 0} × ${entry.name} available. Reduce the quantity.` };
    const price = purchasePrice(entry);
    if (price.error) return price;
    if (unitCost !== undefined && (unitCost !== price.unitCost || denomination !== price.denomination)) {
      return { error: `The price of ${entry.name} changed. Review your basket and try again.` };
    }
    const cost = quantity * price.unitCost;
    total += cost;
    if (!Number.isSafeInteger(total)) return { error: "The basket total is too large." };
    lines.push({ entry, stockId, quantity, cost, approvalIds, ...price });
  }
  return { lines, total };
}

function quotePurchaseRequest(stock, request) {
  // Older pending approval cards carry a single stock ID and quantity.
  const lines = request.lines ?? [{ stockId: request.stockId, quantity: Math.floor(Number(request.quantity ?? 1)) }];
  return quotePurchase(stock, lines);
}

function purchaseRequestLines(lines) {
  return lines.map(({ stockId, quantity, unitCost, denomination, approvalIds }) => ({ stockId, quantity, unitCost, denomination, approvalIds }));
}

const transactionQueues = new Map();
function resolveMerchant(request) {
  if (request.actorUuid?.startsWith("Actor.")) return Promise.resolve(game.actors.get(request.actorUuid.slice("Actor.".length)) ?? null);
  if (request.actorUuid) return fromUuid(request.actorUuid).catch(() => null);
  return Promise.resolve(game.actors.get(request.actorId) ?? null);
}
async function withTransactionLock(merchantId, buyerId, operation) {
  const actorIds = new Set([merchantId, buyerId]);
  const previous = [...actorIds].map(id => transactionQueues.get(id));
  let release;
  const current = new Promise(resolve => { release = resolve; });
  // Reserve both actors before yielding so overlapping purchases and sales serialize.
  for (const id of actorIds) transactionQueues.set(id, current);
  await Promise.all(previous);
  try { return await operation(); }
  finally {
    release();
    for (const id of actorIds) if (transactionQueues.get(id) === current) transactionQueues.delete(id);
  }
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
function purchaseLineList(lines) {
  return `<ul>${lines.map(({ entry, quantity, cost }) =>
    `<li>${quantity} × ${foundry.utils.escapeHTML(entry.name)} (${copperText(cost)})</li>`
  ).join("")}</ul>`;
}
function purchaseApprovalCard({ requestId, requester, buyer, merchant, quote }) {
  const escape = foundry.utils.escapeHTML;
  return `<div class="merchant-approval-card" data-request-id="${escape(requestId)}"><h3>Free Item Approval</h3><p><strong>${escape(buyer.name)}</strong> (${escape(requester.name)}) requests the following from ${escape(merchant.name)}.</p>${purchaseLineList(quote.lines)}<p>Approve adding this free item to the player's basket?</p><button type="button" data-merchant-approval="approve">Approve</button> <button type="button" data-merchant-approval="deny">Deny</button></div>`;
}
async function resolvePurchaseApproval(message, requestId, approved) {
  if (!game.user.isGM || game.users.activeGM?.id !== game.user.id || !message.author?.isGM) return;
  const approval = message.getFlag(MODULE_ID, "purchaseApproval");
  if (approval?.status !== "pending" || approval.requestId !== requestId || !approval.request || !approval.requesterId || processingApprovals.has(message.id)) return;
  processingApprovals.add(message.id);
  const statusPath = `flags.${MODULE_ID}.purchaseApproval.status`;
  try {
    // Claim the persisted card before moving stock, including across client reloads.
    await message.update({ [statusPath]: "processing" });
    const { request, requesterId } = approval;
    const result = approved
      ? await approvePurchaseRequest(request, requesterId)
      : { success: false, message: "The GM declined the free-item request." };
    const status = result.success ? "approved" : approved ? "failed" : "denied";
    const safeText = foundry.utils.escapeHTML(result.message);
    await message.update({
      content: `<div class="merchant-approval-card"><h3>Free Item ${status}</h3><p>${safeText}</p></div>`,
      [statusPath]: status
    });
    await sendPurchaseResult(requesterId, requestId, result);
  } finally {
    processingApprovals.delete(message.id);
  }
}
async function approvePurchaseRequest(request, requesterId) {
  const merchant = await resolveMerchant(request);
  if (!merchant) return { success: false, message: "The selected merchant is no longer available." };
  return withTransactionLock(merchant.id, request.buyerId, () => {
    // Pending approval cards from older versions still complete their purchase.
    if (request.action !== "approveBasketItem") return commitPurchase(merchant, request, requesterId, { approvedFree: true });
    const requester = game.users.get(requesterId);
    if (isShopPaused(requester)) return { success: false, message: PAUSED_SHOP_MESSAGE };
    const buyer = game.actors.get(request.buyerId);
    if (!requester || !canShopAs(buyer, requester) || !isConfiguredShop(merchant)) {
      return { success: false, message: "The shop or shopping character is no longer available." };
    }
    const quote = quotePurchaseRequest(merchant.getFlag(MODULE_ID, "stock") ?? [], request);
    if (quote.error) return { success: false, message: quote.error };
    const [line] = quote.lines;
    if (quote.lines.length !== 1 || line.quantity !== 1 || !line.isFree) {
      return { success: false, message: "Only one zero-priced item can be approved at a time." };
    }
    const approvalId = foundry.utils.randomID();
    const duration = 15 * 60 * 1000;
    basketItemApprovals.set(approvalId, { requesterId, buyerId: buyer.id, merchantUuid: merchant.uuid, stockId: line.stockId, expiresAt: Date.now() + duration });
    window.setTimeout(() => basketItemApprovals.delete(approvalId), duration);
    return { success: true, approvalId, message: "The GM approved the free item." };
  });
}

async function processPurchase(request, authenticatedUserId) {
  if (isShopPaused(game.users.get(authenticatedUserId))) return { success: false, message: PAUSED_SHOP_MESSAGE };
  const merchant = await resolveMerchant(request);
  if (!merchant) return { success: false, message: "That merchant is no longer available." };
  const result = await withTransactionLock(merchant.id, request.buyerId, async () => {
    const requester = game.users.get(authenticatedUserId);
    if (isShopPaused(requester)) return { success: false, message: PAUSED_SHOP_MESSAGE };
    const buyer = game.actors.get(request.buyerId);
    if (!requester || !buyer || !isConfiguredShop(merchant)) return { success: false, message: "That merchant or buyer is no longer available." };
    if (!requester.isGM && !canShopAs(buyer, requester)) return { success: false, message: "You do not own the selected buyer character." };
    if (request.action !== "approveBasketItem") return commitPurchase(merchant, request, authenticatedUserId);
    const quote = quotePurchaseRequest(merchant.getFlag(MODULE_ID, "stock") ?? [], request);
    if (quote.error) return { success: false, message: quote.error };
    if (quote.lines.length !== 1 || quote.lines[0].quantity !== 1 || !quote.lines[0].isFree) {
      return { success: false, message: "Only one zero-priced item can be approved at a time." };
    }
    const approvalRequest = { ...request, lines: purchaseRequestLines(quote.lines) };
    const content = purchaseApprovalCard({ requestId: request.requestId, requester, buyer, merchant, quote });
    if (game.settings.get(MODULE_ID, "zeroPriceApproval") === "dialog") return { approvalContent: content, approvalRequest };
    await ChatMessage.create({
      content,
      whisper: game.users.filter(user => user.isGM).map(user => user.id),
      flags: { [MODULE_ID]: { purchaseApproval: { requestId: request.requestId, status: "pending", requesterId: authenticatedUserId, request: approvalRequest } } }
    });
    return { success: true, pending: true };
  });
  if (!result.approvalContent) return result;
  const approved = await foundry.applications.api.DialogV2.confirm({
    window: { title: "Approve Free Item" },
    content: result.approvalContent.replace(/<button[^>]*>[\s\S]*?<\/button>/g, ""),
    rejectClose: false, modal: true,
    yes: { label: "Approve" }, no: { label: "Deny" }
  });
  if (!approved) return { success: false, message: "The GM declined the free-item request." };
  return approvePurchaseRequest(result.approvalRequest, authenticatedUserId);
}

async function preparePurchasedItem(entry, quantity) {
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
  itemData.system.quantity = quantity;
  delete itemData.system._source;
  return itemData;
}

async function commitPurchase(merchant, request, authenticatedUserId, { approvedFree = false } = {}) {
  const buyer = game.actors.get(request.buyerId), requestingUser = game.users.get(authenticatedUserId);
  if (isShopPaused(requestingUser)) return { success: false, message: PAUSED_SHOP_MESSAGE };
  if (!buyer || !requestingUser || !isConfiguredShop(merchant)) return { success: false, message: "The selected merchant or buyer is no longer available." };
  if (!requestingUser.isGM && !canShopAs(buyer, requestingUser)) return { success: false, message: "You do not own that character." };
  const originalStock = merchant.getFlag(MODULE_ID, "stock") ?? [];
  const stock = foundry.utils.deepClone(originalStock);
  const quote = quotePurchaseRequest(stock, request);
  if (quote.error) return { success: false, message: quote.error };
  if (approvedFree && !quote.lines.some(line => line.isFree)) return { success: false, message: "The basket no longer contains a free item. Review the current prices and try again." };
  const approvalsUsed = new Set();
  for (const line of quote.lines) {
    if (!line.isFree || requestingUser.isGM || approvedFree) continue;
    const ids = line.approvalIds;
    if (!Array.isArray(ids) || ids.length !== line.quantity || !ids.every(id => {
      const approval = basketItemApprovals.get(id);
      if (!approval || approval.expiresAt <= Date.now() || approvalsUsed.has(id)) return false;
      if (approval.requesterId !== authenticatedUserId || approval.buyerId !== buyer.id ||
          approval.merchantUuid !== merchant.uuid || approval.stockId !== line.stockId) return false;
      approvalsUsed.add(id);
      return true;
    })) return { success: false, message: "A free item needs fresh GM approval. Remove it from the basket and add it again." };
  }
  const buyerCurrency = buyer.system.currency ?? {}, merchantCurrency = merchant.system.currency ?? {};
  if (copperValue(buyerCurrency) < quote.total) return { success: false, message: `Insufficient funds. Your current purse is ${currencyText(buyerCurrency)}.` };
  let nextBuyerCurrency = buyerCurrency, nextMerchantCurrency = merchantCurrency;
  const itemIds = new Set();
  const soldOut = new Set();
  let buyerUpdated = false, merchantUpdated = false;
  let stage = "preparing the basket";
  try {
    const items = [];
    for (const { entry, quantity, cost, denomination } of quote.lines) {
      if (cost) {
        nextBuyerCurrency = deductCurrencyForTransaction(nextBuyerCurrency, cost, denomination);
        nextMerchantCurrency = addCurrencyForTransaction(nextMerchantCurrency, cost, denomination);
      }
      const data = await preparePurchasedItem(entry, quantity);
      data._id = foundry.utils.randomID();
      items.push(data);
      entry.quantity = Number(entry.quantity) - quantity;
      if (entry.quantity === 0) soldOut.add(entry.id);
    }
    if (isShopPaused(requestingUser)) return { success: false, message: PAUSED_SHOP_MESSAGE };
    stage = "adding items to the character inventory";
    // Known IDs let us remove items if the document write fails partway through.
    for (const data of items) itemIds.add(data._id);
    const created = await buyer.createEmbeddedDocuments("Item", items, { keepId: true });
    for (const item of created) itemIds.add(item.id);
    if (created.length < items.length) throw new Error("Foundry did not create every item in the basket.");
    if (quote.total) {
      stage = "deducting the character's money";
      buyerUpdated = true;
      await buyer.update({ "system.currency": nextBuyerCurrency });
    }
    stage = "updating merchant funds and shop stock";
    merchantUpdated = true;
    await merchant.update({
      ...(quote.total ? { "system.currency": nextMerchantCurrency } : {}),
      [`flags.${MODULE_ID}.stock`]: stock.filter(entry => !soldOut.has(entry.id))
    });
  } catch (error) {
    console.error(`${MODULE_ID} | Purchase failed while ${stage}.`, error);
    const restore = [];
    if (merchantUpdated) restore.push(() => merchant.update({ "system.currency": merchantCurrency, [`flags.${MODULE_ID}.stock`]: originalStock }));
    if (buyerUpdated) restore.push(() => buyer.update({ "system.currency": buyerCurrency }));
    const createdIds = [...itemIds].filter(id => buyer.items.has(id));
    if (createdIds.length) restore.push(() => buyer.deleteEmbeddedDocuments("Item", createdIds));
    for (const operation of restore) {
      try { await operation(); }
      catch (rollbackError) { console.error(`${MODULE_ID} | Purchase rollback failed.`, rollbackError); }
    }
    return { success: false, message: `The purchase failed while ${stage}. Check the GM console for details.` };
  }
  for (const id of approvalsUsed) basketItemApprovals.delete(id);
  const escape = foundry.utils.escapeHTML;
  const gmIds = game.users.filter(user => user.isGM).map(user => user.id);
  const card = `<div class="merchant-purchase-card"><h3>Merchant Purchase</h3><p><strong>${escape(buyer.name)}</strong> (${escape(requestingUser.name)}) purchased from ${escape(merchant.name)}.</p>${purchaseLineList(quote.lines)}<p>Total: ${copperText(quote.total)}</p></div>`;
  void ChatMessage.create({ content: card, whisper: gmIds }).catch(error => console.error(`${MODULE_ID} | Could not create purchase chat card.`, error));
  const count = quote.lines.reduce((sum, line) => sum + line.quantity, 0);
  return { success: true, message: `Purchased ${count} item${count === 1 ? "" : "s"} for ${copperText(quote.total)}.` };
}
function requestPurchase(request) {
  return new Promise(resolve => {
    const { requestId } = request;
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
      flags: { [MODULE_ID]: { purchaseRequest: request } }
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
      lines, totalCopper, persuasionUsed, outcome
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
  if (isShopPaused(game.users.get(authenticatedUserId))) return saleResultToPlayer(authenticatedUserId, request.requestId, { success: false, message: PAUSED_SHOP_MESSAGE });
  const requester = game.users.get(authenticatedUserId), buyer = game.actors.get(request.buyerId), merchant = await resolveMerchant({ actorId: request.merchantId, actorUuid: request.merchantUuid });
  if (!requester || !buyer || !merchant || !isConfiguredShop(merchant)) return saleResultToPlayer(authenticatedUserId, request.requestId, { success: false, message: "That merchant or character is no longer available." });
  if (!requester.isGM && !canShopAs(buyer, requester)) return saleResultToPlayer(authenticatedUserId, request.requestId, { success: false, message: "You do not own the character offering these items." });
  if (pendingSales.has(request.requestId)) return;
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
  const sale = { request, requester, requesterId: authenticatedUserId, buyer, merchant, items, currentOffer: null, persuasionUsed: false };
  pendingSales.set(request.requestId, sale);
  const offer = await promptGmSaleOffer(sale);
  if (!offer) {
    pendingSales.delete(request.requestId);
    return saleResultToPlayer(authenticatedUserId, request.requestId, { success: false, message: "The merchant declined to review this sale." });
  }
  if (isShopPaused(requester)) {
    pendingSales.delete(request.requestId);
    return saleResultToPlayer(authenticatedUserId, request.requestId, { success: false, message: PAUSED_SHOP_MESSAGE });
  }
  sale.currentOffer = offer;
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
  const status = document.createElement("p"); status.className = "merchant-sale-status";
  const actions = document.createElement("div"); actions.className = "purchase-dialog-actions";
  const accept = document.createElement("button"); accept.type = "button"; accept.textContent = "Accept Offer";
  const persuade = document.createElement("button"); persuade.type = "button"; persuade.textContent = "Try Persuasion"; persuade.disabled = Boolean(offer.persuasionUsed);
  const decline = document.createElement("button"); decline.type = "button"; decline.textContent = "Decline";
  actions.append(accept, persuade, decline); panel.append(list, total, status, actions);
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
    status.textContent = "Opening Foundry's Persuasion roll…";
    const actor = game.actors.get(offer.buyerId);
    if (!canShopAs(actor, game.user)) {
      status.textContent = "You no longer control the character who submitted the items.";
      persuade.disabled = false;
      return;
    }
    let hookedRoll = null;
    const existingMessageIds = new Set(game.messages.map(message => message.id));
    const hookId = Hooks.on("dnd5e.rollSkill", (rolls, data) => {
      if (data?.skill !== "per" || data?.subject?.uuid !== actor.uuid) return;
      hookedRoll = rolls?.find(roll => Number.isFinite(roll?.total)) ?? null;
    });
    try {
      await actor.rollSkill({ skill: "per" });
      if (!hookedRoll) {
        status.textContent = "The Persuasion roll was cancelled. You can accept or decline the offer.";
        persuade.disabled = false;
        return;
      }
      const rollMessage = [...game.messages]
        .filter(message => !existingMessageIds.has(message.id)
          && (message.author?.id ?? message.user?.id) === game.user.id
          && message.speaker?.actor === actor.id
          && message.rolls?.some(roll => Number.isFinite(roll?.total) && roll.total === hookedRoll.total))
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      if (!rollMessage) throw new Error("Could not find the Foundry skill-roll message.");
      await rollMessage.update({ [`flags.${MODULE_ID}.persuasionRoll`]: { requestId: offer.requestId, actorId: actor.id } });
      const activeGM = game.users.activeGM;
      if (!activeGM) throw new Error("No active GM is connected.");
      await ChatMessage.create({ content: "", whisper: [activeGM.id], flags: { [MODULE_ID]: { saleResponse: { requestId: offer.requestId, action: "persuade", rollMessageId: rollMessage.id } } } });
      close();
    } catch (error) {
      console.error(`${MODULE_ID} | Persuasion roll failed.`, error);
      status.textContent = "The Persuasion roll could not be sent. You can accept or decline the offer.";
      persuade.disabled = false;
    } finally {
      Hooks.off("dnd5e.rollSkill", hookId);
    }
  });
  overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
  overlay.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
}
async function processSaleResponse(response, authenticatedUserId) {
  const sale = pendingSales.get(response.requestId);
  if (!sale?.currentOffer || authenticatedUserId !== sale.requesterId || sale.negotiating) return;
  if (response.action === "decline") {
    pendingSales.delete(response.requestId);
    return saleResultToPlayer(sale.requesterId, response.requestId, { success: false, message: "You declined the merchant's offer." });
  }
  if (isShopPaused(sale.requester)) return saleResultToPlayer(sale.requesterId, response.requestId, { success: false, message: PAUSED_SHOP_MESSAGE });
  if (response.action === "accept") {
    pendingSales.delete(response.requestId);
    const result = await withTransactionLock(sale.merchant.id, sale.buyer.id, () => commitSale(sale));
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
  if (!isConfiguredShop(sale.merchant)) {
    pendingSales.delete(response.requestId);
    return saleResultToPlayer(sale.requesterId, response.requestId, { success: false, message: "This merchant is no longer set up as a shop." });
  }
  if (!sale.requester.isGM && !canShopAs(game.actors.get(sale.buyer.id), sale.requester)) {
    pendingSales.delete(response.requestId);
    return saleResultToPlayer(sale.requesterId, response.requestId, { success: false, message: "You no longer control the character offering these items." });
  }
  const rollMessage = game.messages.get(response.rollMessageId);
  const rollAuthorId = rollMessage?.author?.id ?? rollMessage?.user?.id;
  const rollTotal = rollMessage?.rolls?.[0]?.total;
  const rollFlag = rollMessage?.getFlag(MODULE_ID, "persuasionRoll");
  if (!rollMessage || rollAuthorId !== authenticatedUserId || rollMessage.speaker?.actor !== sale.buyer.id || rollFlag?.requestId !== response.requestId || rollFlag?.actorId !== sale.buyer.id || !Number.isFinite(rollTotal)) {
    return sendSaleOffer(sale, { outcome: "The Persuasion roll could not be verified. The current offer remains open.", persuasionUsed: false });
  }
  sale.negotiating = true;
  try {
    let insightRoll;
    try {
      insightRoll = await rollMerchantInsight(sale.merchant);
    } catch (error) {
      console.error(`${MODULE_ID} | Merchant Insight roll failed.`, error);
    }
    if (!insightRoll || !Number.isFinite(insightRoll.total)) {
      return sendSaleOffer(sale, { outcome: "The merchant's Insight roll was cancelled or unavailable. The current offer remains open.", persuasionUsed: false });
    }
    sale.persuasionUsed = true;
    if (rollTotal > insightRoll.total) {
      const rollSummary = `${sale.buyer.name} Persuasion: ${rollTotal}. ${sale.merchant.name} Insight: ${insightRoll.total}. The character won and may receive a revised offer.`;
      const revised = await promptGmSaleOffer(sale, { previous: sale.currentOffer, rollSummary });
      if (revised && !revised.keep) sale.currentOffer = revised;
      await sendSaleOffer(sale, { outcome: "Your Persuasion check succeeded. The merchant is reconsidering the offer.", persuasionUsed: true });
    } else {
      const rollSummary = `${sale.buyer.name} Persuasion: ${rollTotal}. ${sale.merchant.name} Insight: ${insightRoll.total}. The merchant held firm; the offer is unchanged.`;
      await sendSaleOffer(sale, { outcome: "The merchant was not persuaded. The offer remains unchanged.", persuasionUsed: true });
    }
  } finally {
    sale.negotiating = false;
  }
}
async function rollMerchantInsight(merchant) {
  let hookedRoll = null;
  const hookId = Hooks.on("dnd5e.rollSkill", (rolls, data) => {
    if (data?.skill !== "ins" || data?.subject?.uuid !== merchant.uuid) return;
    hookedRoll = rolls?.find(roll => Number.isFinite(roll?.total)) ?? null;
  });
  try {
    // Use dnd5e's own skill workflow so its roll dialog, roll mode, bonuses,
    // and other modules' skill-roll hooks are available to the GM.
    const result = await merchant.rollSkill({ skill: "ins" });
    return hookedRoll ?? (Number.isFinite(result?.total) ? result : null);
  } finally {
    Hooks.off("dnd5e.rollSkill", hookId);
  }
}
async function commitSale(sale) {
  const { merchant, currentOffer, requester } = sale;
  if (isShopPaused(requester)) return { success: false, message: PAUSED_SHOP_MESSAGE };
  const buyer = game.actors.get(sale.buyer.id);
  if (!buyer || (!requester.isGM && !canShopAs(buyer, requester))) return { success: false, message: "You no longer control the character offering these items." };
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
    await buyer.update({ "system.currency": addCurrencyForTransaction(buyerCurrency, total, "gp") });
    merchantUpdateAttempted = true;
    await merchant.update({ "system.currency": deductCurrencyForTransaction(merchantCurrency, total, "gp"), [`flags.${MODULE_ID}.stock`]: stock });
  return { success: true, message: `The merchant paid you ${goldText(total)} for your items.` };
  } catch (error) {
    console.error(`${MODULE_ID} | Sale transaction failed.`, error);
    try {
      if (merchantUpdateAttempted) await merchant.update({ "system.currency": merchantCurrency, [`flags.${MODULE_ID}.stock`]: originalStock });
      if (buyerMoneyAttempted) await buyer.update({ "system.currency": buyerCurrency });
      const deletedSources = soldRecords
        .filter(record => fullItems.includes(record.item) && !buyer.items.has(record.item.id))
        .map(record => ({ ...record.data, _id: record.item.id }));
      if (deletedSources.length) await buyer.createEmbeddedDocuments("Item", deletedSources, { keepId: true, keepEmbeddedIds: true });
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
    this.element.querySelectorAll(".merchant-gm-sale-line input").forEach(input => {
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
    if (!lines.length) return;
    this.finish({ lines });
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
      if (!item || item.parent?.uuid !== this.actor.uuid || !this.actor.items.has(item.id)) return ui.notifications.warn("Only items in the selected character's inventory can be sold.");
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
    this.stockSearch = "";
    this.stockTypeFilter = "all";
    this.basket = new Map();
    this.pendingBasketItems = new Map();
    merchantSheetSubscribers.add(this);
  }
  static DEFAULT_OPTIONS = {
    id: "merchant-npc", tag: "form", classes: ["merchant-npc"], window: { title: "Merchant Shop", resizable: true }, position: { width: 1000, height: 720 },
    form: { handler: MerchantSheet.#onSubmit, submitOnChange: false },
    actions: { addItems: MerchantSheet.#addItems, clearShop: MerchantSheet.#clearShop, removeItem: MerchantSheet.#removeItem, saveItem: MerchantSheet.#saveItem, changeBasket: MerchantSheet.#changeBasket, checkout: MerchantSheet.#checkout, sellItems: MerchantSheet.#sellItems, setFloat: MerchantSheet.#setFloat, setShopType: MerchantSheet.#setShopType }
  };
  static PARTS = { form: { template: "modules/merchant-npc/templates/merchant-sheet.hbs" } };
  _onClose(options) {
    merchantSheetSubscribers.delete(this);
    this.resetBasket();
    return super._onClose?.(options);
  }
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
    const searchInput = this.element.querySelector("[name='stockSearch']");
    searchInput?.addEventListener("input", () => {
      this.stockSearch = searchInput.value;
      this.#filterStock();
    });
    for (const button of this.element.querySelectorAll("[data-stock-type-filter]")) {
      button.addEventListener("click", () => {
        this.stockTypeFilter = button.dataset.stockTypeFilter;
        for (const filterButton of this.element.querySelectorAll("[data-stock-type-filter]")) {
          const active = filterButton === button;
          filterButton.classList.toggle("active", active);
          filterButton.setAttribute("aria-pressed", String(active));
        }
        this.#filterStock();
      });
    }
    this.#filterStock();
  }
  get title() { return `${this.actor.name} — ${SHOP_TYPES[this.shopType] ?? SHOP_TYPES.general}`; }
  get shopper() {
    const actor = game.actors.get(this.shopperId);
    return !isShopPaused() && isConfiguredShop(this.actor) && canShopAs(actor, game.user) ? actor : null;
  }
  async _prepareContext() {
    const shopper = this.shopper;
    this.shopType = this.actor.getFlag(MODULE_ID, "shopType") ?? this.shopType ?? "general";
    const stock = (this.actor.getFlag(MODULE_ID, "stock") ?? []).map(item => {
      const price = item.system?.price;
      const rawPrice = price?.value ?? price?.amount;
      const hasPrice = rawPrice != null && rawPrice !== "";
      const type = String(item.type ?? "other");
      const description = tooltipText(item.system?.description?.value ?? item.system?.description ?? "");
      const cartQuantity = getCartQuantity(this.actor.uuid, item.id);
      const awaitingApproval = this.pendingBasketItems.has(item.id);
      const canAdd = !this.checkoutPending && !awaitingApproval && !purchasePrice(item).error
        && (this.basket.get(item.id)?.quantity ?? 0) < Number(item.quantity);
      return {
        ...item, type, typeLabel: type.charAt(0).toUpperCase() + type.slice(1), description,
        cartLabel: cartQuantity ? `${cartQuantity} in baskets` : "", awaitingApproval, canAdd,
        availableQuantity: Math.max(0, Number(item.quantity)), outOfStock: Number(item.quantity) <= 0,
        searchText: `${item.name ?? ""} ${type} ${description}`.toLocaleLowerCase(),
        hasPrice, priceMissing: !hasPrice, priceZero: !hasPrice || Number(rawPrice) === 0,
        priceText: hasPrice ? priceLabel(price) : "Price not set", denomination: price?.denomination ?? price?.currency ?? "gp"
      };
    });
    const basket = [...this.basket.values()];
    const stockById = new Map(stock.map(item => [item.id, item]));
    const basketLines = basket.map(line => {
      const entry = stockById.get(line.stockId);
      const price = entry && purchasePrice(entry);
      const cost = price && !price.error ? price.unitCost * line.quantity : null;
      return { ...line, canAdd: entry?.canAdd, costText: cost === null ? "Unavailable" : copperText(cost) };
    });
    const quote = quotePurchase(stock, basket);
    let basketError = basket.length ? quote.error : null;
    if (quote.lines?.some(line => line.isFree && line.approvalIds.length !== line.quantity)) {
      basketError = "Remove and re-add any free items that still need GM approval.";
    }
    if (shopper && quote.total > copperValue(shopper.system.currency ?? {})) basketError = "Your character has insufficient funds.";
    const stockTypes = [...new Set(stock.map(item => item.type))]
      .sort((a, b) => a.localeCompare(b))
      .map(value => ({ value, label: value.charAt(0).toUpperCase() + value.slice(1), count: stock.filter(item => item.type === value).length, active: value === this.stockTypeFilter }));
    if (this.stockTypeFilter !== "all" && !stockTypes.some(type => type.value === this.stockTypeFilter)) this.stockTypeFilter = "all";
    return {
      actor: this.actor,
      stock,
      stockTypes,
      stockSearch: this.stockSearch,
      stockTypeFilter: this.stockTypeFilter,
      allStockTypesActive: this.stockTypeFilter === "all",
      isGM: game.user.isGM,
      shopperName: shopper?.name,
      canPurchase: !game.user.isGM && Boolean(shopper),
      basketLines,
      basketError,
      basketTotal: quote.total === undefined ? null : copperText(quote.total),
      basketTotalCopper: quote.total,
      shopperFunds: shopper && currencyText(shopper.system.currency ?? {}),
      canCheckout: basket.length > 0 && !basketError && !this.checkoutPending,
      checkoutPending: Boolean(this.checkoutPending),
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
  #filterStock() {
    if (!this.element) return;
    const query = this.stockSearch.trim().toLocaleLowerCase();
    const rows = [...this.element.querySelectorAll("[data-stock-item]")];
    let visible = 0;
    for (const row of rows) {
      const matches = (this.stockTypeFilter === "all" || row.dataset.stockType === this.stockTypeFilter)
        && (!query || row.dataset.stockSearch.includes(query));
      row.hidden = !matches;
      if (matches) visible++;
    }
    const resultCount = this.element.querySelector("[data-stock-result-count]");
    if (resultCount) resultCount.textContent = String(visible);
    const noMatches = this.element.querySelector("[data-stock-no-matches]");
    if (noMatches) noMatches.hidden = visible > 0 || rows.length === 0;
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
  static async #clearShop() {
    if (!game.user.isGM) return ui.notifications.error("Only the GM can clear a merchant's shop.");
    const stock = this.actor.getFlag(MODULE_ID, "stock") ?? [];
    if (!stock.length) return ui.notifications.info("This shop is already empty.");
    const actorName = foundry.utils.escapeHTML(this.actor.name);
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: "Clear Merchant Shop" },
      content: `<p>Remove all ${stock.length} listed item entries from <strong>${actorName}</strong>'s shop? This cannot be undone.</p>`,
      rejectClose: false,
      modal: true,
      yes: { label: "Clear Shop" },
      no: { label: "Cancel" }
    });
    if (!confirmed) return;
    await this.actor.setFlag(MODULE_ID, "stock", []);
    this.stockSearch = "";
    this.stockTypeFilter = "all";
    this._restoreShopScrollTop = 0;
    this.render();
    ui.notifications.info(`${stock.length} item entries cleared from ${this.actor.name}'s shop.`);
  }
  static async #saveItem(_event, target) {
    const row = target.closest("[data-stock-id]");
    const id = row?.dataset.stockId;
    const stock = foundry.utils.deepClone(this.actor.getFlag(MODULE_ID, "stock") ?? []);
    const item = stock.find(entry => entry.id === id);
    if (!item || !row) return;
    const quantity = Number(row.querySelector("[name='quantity']")?.value ?? 0);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      const updatedStock = stock.filter(entry => entry.id !== id);
      await this.actor.setFlag(MODULE_ID, "stock", updatedStock);
      this._restoreShopScrollTop = this.element.querySelector(".merchant-layout")?.scrollTop ?? 0;
      this.render();
      ui.notifications.info(`${item.name} was removed from the shop because its quantity was set to zero.`);
      return;
    }
    item.quantity = Math.floor(quantity);
    item.system.price ??= {};
    const price = Number(row.querySelector("[name='price']")?.value ?? 0);
    item.system.price.value = Number.isFinite(price) ? Math.max(0, price) : 0;
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
    const currency = addCurrencyForTransaction({}, Math.round(gp * CURRENCY.gp), "gp");
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
  resetBasket() {
    this.clearBasket();
    this.pendingBasketItems.clear();
  }
  clearBasket() {
    for (const id of this.basket.keys()) publishCartCount(this.actor.uuid, id, 0);
    this.basket.clear();
  }
  static async #changeBasket(_event, target) {
    const buyer = this.shopper;
    if (!buyer || this.checkoutPending) return;
    const { id, change } = target.dataset;
    const current = this.basket.get(id);
    if (change === "remove" || change === "-1") {
      this.pendingBasketItems.delete(id);
      if (change === "remove" || !current || current.quantity <= 1) {
        this.basket.delete(id);
        publishCartCount(this.actor.uuid, id, 0);
      } else {
        current.quantity--;
        current.approvalIds.pop();
        publishCartCount(this.actor.uuid, id, current.quantity);
      }
      return;
    }
    if (change !== "1" || this.pendingBasketItems.has(id)) return;
    const stock = this.actor.getFlag(MODULE_ID, "stock") ?? [];
    const quantity = (current?.quantity ?? 0) + 1;
    const quote = quotePurchase(stock, [{ stockId: id, quantity }]);
    if (quote.error) return ui.notifications.warn(quote.error);
    const [line] = quote.lines;
    let approvalId;
    if (line.isFree) {
      const request = {
        requestId: foundry.utils.randomID(), action: "approveBasketItem",
        actorId: this.actor.id, actorUuid: this.actor.uuid, buyerId: buyer.id,
        lines: purchaseRequestLines([{ ...line, quantity: 1 }])
      };
      this.pendingBasketItems.set(id, request.requestId);
      this.render();
      const result = await requestPurchase(request);
      if (this.checkoutPending) await this.checkoutPending;
      if (this.pendingBasketItems.get(id) !== request.requestId) return;
      this.pendingBasketItems.delete(id);
      this.render();
      if (!result?.success || !result.approvalId) return ui.notifications.warn(result?.message ?? "The free item was not approved.");
      if (isShopPaused() || this.shopper?.id !== buyer.id) return;
      approvalId = result.approvalId;
    }
    const latest = (this.actor.getFlag(MODULE_ID, "stock") ?? []).find(item => item.id === id);
    const basketLine = this.basket.get(id) ?? { stockId: id, name: line.entry.name, quantity: 0, approvalIds: [] };
    if (!latest || !(Number(latest.quantity) > basketLine.quantity)) return ui.notifications.warn("That item is out of stock.");
    const price = purchasePrice(latest);
    if (price.error || price.isFree !== line.isFree) return ui.notifications.warn("The item price changed. Add it again at the current price.");
    basketLine.quantity++;
    if (approvalId) basketLine.approvalIds.push(approvalId);
    this.basket.set(id, basketLine);
    publishCartCount(this.actor.uuid, id, basketLine.quantity);
  }
  static async #checkout(_event, target) {
    const buyer = this.shopper;
    if (!buyer || this.checkoutPending) return;
    const quote = quotePurchase(this.actor.getFlag(MODULE_ID, "stock") ?? [], [...this.basket.values()]);
    if (quote.error) return ui.notifications.warn(quote.error);
    if (Number(target.dataset.total) !== quote.total) {
      this.render();
      return ui.notifications.warn("The basket total changed. Review it before purchasing.");
    }
    const request = {
      requestId: foundry.utils.randomID(), actorId: this.actor.id, actorUuid: this.actor.uuid,
      buyerId: buyer.id, lines: purchaseRequestLines(quote.lines)
    };
    this.checkoutPending = requestPurchase(request);
    this.render();
    try {
      const result = await this.checkoutPending;
      if (!result?.success) return ui.notifications.warn(result?.message ?? "The purchase could not be completed.");
      this.clearBasket();
      ui.notifications.info(result.message ?? "Purchase completed.");
    } finally {
      this.checkoutPending = null;
      if (this.rendered) this.render();
    }
  }
  static async #sellItems() {
    const buyer = this.shopper;
    if (!buyer) return ui.notifications.warn("You no longer control the selected shopping character.");
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
    this.selectedSources = new Set();
    this.search = "";
    this.visibleItems = [];
    this.loadingDialog = null;
    this.loadingStartedAt = 0;
    this.filterLoading = false;
    catalogSubscribers.add(this);
  }
  render(options = {}) {
    // Filtering rerenders this ApplicationV2 sheet. Keep the independent scroll
    // panes stable so unchecking a source does not send the user back to the top.
    if (this.element?.isConnected) {
      this._scrollPositions = [".type-pane .filter-list", ".source-pane .filter-list", ".available-item-list"]
        .map(selector => [selector, this.element.querySelector(selector)?.scrollTop ?? 0]);
    }
    return super.render(options);
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
    for (const [selector, scrollTop] of this._scrollPositions ?? []) {
      const pane = this.element.querySelector(selector);
      if (pane) pane.scrollTop = scrollTop;
    }
    this._scrollPositions = null;
    const refresh = () => {
      this.search = this.element.querySelector("[name='itemSearch']")?.value ?? "";
      this.render();
    };
    for (const checkbox of this.element.querySelectorAll("[name='itemType']")) checkbox.addEventListener("change", () => {
      this.selectedTypes = new Set([...this.element.querySelectorAll("[name='itemType']:checked")].map(input => input.value));
      this.selectedSources = new Set();
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
      const packs = game.packs.filter(candidate => candidate.documentName === "Item" && !/monster/i.test(candidate.title ?? ""));
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
    const requested = this.element.querySelector("[name='randomCount']")?.value ?? game.settings.get(MODULE_ID, "randomCount");
    const count = Math.max(1, Math.min(100, Math.floor(Number(requested)) || 1));
    const candidates = [...this.visibleItems];
    if (!candidates.length) return ui.notifications.warn("No items match the selected item types and compendiums.");
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const items = [];
    let offset = 0;
    while (items.length < count && offset < candidates.length) {
      const batch = candidates.slice(offset, offset + count - items.length);
      offset += batch.length;
      const resolved = await mapWithConcurrency(batch, 6, record =>
        this.#resolveItem(record.source, record._id).catch(() => null)
      );
      items.push(...resolved.filter(Boolean));
    }
    if (!items.length) return ui.notifications.warn("Could not load any of the matching items.");
    const copies = Math.floor(count / items.length);
    const extra = count % items.length;
    await this.merchantSheet.addStockMany(items.map((item, index) => ({
      source: item.toObject(),
      quantity: copies + (index < extra ? 1 : 0)
    })));
    ui.notifications.info(`Added ${count} random item${count === 1 ? "" : "s"} to the shop.`);
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
        const rollTablePacks = game.packs.filter(candidate => candidate.documentName === "RollTable" && !/monster/i.test(candidate.title ?? ""));
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
