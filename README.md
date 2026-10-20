# Merchant NPC

An installable Foundry VTT module for Foundry 13.351 and D&D 5e 5.0.0.

## GitHub distribution

Repository: [Tinhead69/Tinheads-Merchant-NPC](https://github.com/Tinhead69/Tinheads-Merchant-NPC)  
Foundry manifest URL: `https://raw.githubusercontent.com/Tinhead69/Tinheads-Merchant-NPC/main/module.json`  
Release download URL: `https://github.com/Tinhead69/Tinheads-Merchant-NPC/releases/download/v0.1.11/merchant-npc-0.1.11.zip`

In Foundry's **Install Module** screen, paste the manifest URL. For each release, create a GitHub release whose tag matches the version (for example, `v0.1.11`) and attach the ZIP with the exact filename shown in the release download URL above. Update the version and download URL in `module.json` for subsequent releases.

## Install

Copy the `merchant-npc` folder into your Foundry `Data/modules` directory, then enable **Merchant NPC** in the world's Manage Modules window. If packaging for a module manifest, zip the contents with `module.json` at the archive root.

## Use

- Double-click a configured NPC in the Actors directory or its canvas token to open the shop. Players without observer-level permission can also right-click its canvas token and click the shop icon in the Token HUD. Players with observer permission can view the NPC sheet and open the shop from its header or directory context menu.
- GMs can set the shop type on the merchant sheet. Jewellers receive ten-times-higher float presets.
- GMs can use the three-pane **Add Items** browser to dynamically filter by item type and source, add individual items, randomly add items from selected sources, or roll world and compendium Rollable Tables with linked items in the selected categories. Item descriptions appear on hover in both the browser and shop inventory. Item compendiums with fewer than five supported items are hidden.
- Add Items starts with all category checkboxes off. Its categories are Potions, Weapons, Armour, Magic Items, and Normal Equipment; magical weapons and armour stay in their physical category.
- The merchant sheet shows the full shop inventory. GMs can edit stock quantities and prices, remove items, and set a starting purse. Repeated additions and repeated Rollable Table results are allowed and increase the stock quantity. Item prices and denominations are copied from the source item, and the GM is alerted when a listed item has no price.
- GMs can set the merchant's purse to a custom amount in gp, or use Poor (200 gp), Average (500 gp), and Rich (1,000 gp) starting-float presets. Jewellers use ten times those preset values.
- Set each item's price in its D&D 5e item data before listing it. Stock quantity is tracked by the shop; a purchase sells one unit.
- Players click **Purchase** using the character assigned to their Foundry user. The active GM validates the purchase, totals that character's `system.currency` denominations, checks the exact value against the price, deducts the price, adds the item to the character, credits the merchant, and reduces stock.
- Merchant stock is saved in the NPC actor's `merchant-npc.stock` flag; merchant funds use the NPC's normal D&D 5e currency fields.

## Notes

This initial version handles the standard D&D 5e coin denominations (pp, gp, ep, sp, cp), converts currency to the exact copper value for affordability, and re-denominates the remaining balance. It assumes item prices use the standard denomination values and the `system.price.value` plus `system.price.denomination` data fields. It does not apply discounts, taxes, or quantity multipliers.
