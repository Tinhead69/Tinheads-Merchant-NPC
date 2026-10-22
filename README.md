# Merchant NPC

An installable Foundry VTT module for Foundry 13.351 and D&D 5e 5.0.0.

## GitHub distribution

Repository: [Tinhead69/Tinheads-Merchant-NPC](https://github.com/Tinhead69/Tinheads-Merchant-NPC)  
Foundry manifest URL: `https://raw.githubusercontent.com/Tinhead69/Tinheads-Merchant-NPC/main/module.json`  
Module download URL: `https://github.com/Tinhead69/Tinheads-Merchant-NPC/archive/refs/heads/main.zip`

Player purchase requests are sent as private chat messages to the active GM. The GM validates the authenticated user ID supplied by Foundry's document creation hook before processing the request; client-provided user IDs are not trusted.

In Foundry's **Install Module** screen, paste the manifest URL. The manifest download URL points to the repository main branch archive. Update the module version before distributing subsequent changes.

## Install

Copy the `merchant-npc` folder into your Foundry `Data/modules` directory, then enable **Merchant NPC** in the world's Manage Modules window. When packaging, keep the `merchant-npc` folder at the archive root, matching the GitHub source archive layout.

## Use

- Double-click a configured NPC in the Actors directory or its canvas token to open the shop. Players without observer-level permission can also right-click its canvas token and click the shop icon in the Token HUD. Players with observer permission can view the NPC sheet and open the shop from its header or directory context menu.
- GMs can set the shop type on the merchant sheet. Jewellers receive ten-times-higher float presets.
- GMs can use the three-pane **Add Items** browser to dynamically filter by item type and source, add individual items, randomly add items from selected sources, or roll world and compendium Rollable Tables with linked items in the selected categories. Item descriptions appear on hover in both the browser and shop inventory. Item compendiums with fewer than five supported items are hidden. Item compendiums appear as each index finishes loading; a source that takes over five seconds or fails to load is skipped. Item compendium and roll-table catalogs are cached for the current Foundry session. Compendium indexing and linked table-result lookups use bounded concurrency, and adding batches of random or table stock uses one update.
- Add Items starts with all category checkboxes off. Its categories are Potions, Weapons, Armour, Magic Items, and Normal Equipment; spells are excluded, and magical equipment is listed as Magic Items only when marked magical. Magical weapons and armour stay in their physical category.
- The merchant sheet shows the full shop inventory. GMs can edit stock quantities and prices, remove items, and set a starting purse. Repeated additions and repeated Rollable Table results are allowed and increase the stock quantity. Item prices and denominations are copied from the source item, and the GM is alerted when a listed item has no price.
- GMs can set the merchant's purse to a custom amount in gp, or use Poor (200 gp), Average (500 gp), and Rich (1,000 gp) starting-float presets. Jewellers use ten times those preset values.
- Set each item's price in its D&D 5e item data before listing it. Stock quantity is tracked by the shop; buyers can select a quantity up to the available stock.
- Players click **Purchase** using the character assigned to their Foundry user, choose a quantity, and see their purse and total before confirming. Purchases are validated and completed automatically using the exact value of all `system.currency` denominations; currency is deducted, the purchased quantity is added to the character, merchant funds are credited, and stock is reduced. Positive-priced purchases complete automatically when the buyer has enough funds. An item priced at exactly 0 requires GM approval; choose **GM chat card** or **GM pop-up dialog** under **Game Settings → Configure Settings → Merchant NPC**. The active GM client handles the permission-secured transaction in the background. Source item data is cached in the GM client rather than copied into each stock entry, keeping transaction updates smaller. After a completed purchase, GMs receive a private chat card with the buyer, item, quantity, merchant, and total. Items with no price set cannot be purchased.
- Merchant stock is saved in the NPC actor's `merchant-npc.stock` flag; merchant funds use the NPC's normal D&D 5e currency fields.

## Notes

This initial version handles the standard D&D 5e coin denominations (pp, gp, ep, sp, cp), converts currency to the exact copper value for affordability, and re-denominates the remaining balance. It assumes item prices use the standard denomination values and the `system.price.value` plus `system.price.denomination` data fields. It does not apply discounts, taxes, or quantity multipliers.




















