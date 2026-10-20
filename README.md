# Merchant NPC

An installable Foundry VTT module for Foundry 13.351 and D&D 5e 5.0.0.

## GitHub distribution

Repository: [Tinhead69/Tinheads-Merchant-NPC](https://github.com/Tinhead69/Tinheads-Merchant-NPC)  
Foundry manifest URL: `https://raw.githubusercontent.com/Tinhead69/Tinheads-Merchant-NPC/main/module.json`  
Release download URL: `https://github.com/Tinhead69/Tinheads-Merchant-NPC/releases/download/v0.1.1/merchant-npc-0.1.1.zip`

In Foundry's **Install Module** screen, paste the manifest URL. For each release, create a GitHub release whose tag matches the version (for example, `v0.1.1`) and attach the ZIP with the exact filename shown in the release download URL above. Update the version and download URL in `module.json` for subsequent releases.

## Install

Copy the `merchant-npc` folder into your Foundry `Data/modules` directory, then enable **Merchant NPC** in the world's Manage Modules window. If packaging for a module manifest, zip the contents with `module.json` at the archive root.

## Use

- Open an NPC actor sheet and click **Shop** in its header, or use **Open Merchant Shop** from the Actors directory context menu.
- GMs can add world items with the selector, drag items from the Items sidebar or a compendium onto the shop, remove stock, and choose compendiums for random stock generation.
- Set each item's price in its D&D 5e item data before listing it. Stock quantity is tracked by the shop; a purchase sells one unit.
- Players choose a character they own and click **Buy**. The module totals that character's `system.currency` denominations, checks the exact value against the price, deducts the price, adds the item to the character, credits the merchant, and reduces stock.
- Merchant stock is saved in the NPC actor's `merchant-npc.stock` flag; merchant funds use the NPC's normal D&D 5e currency fields.

## Notes

This initial version handles the standard D&D 5e coin denominations (pp, gp, ep, sp, cp), converts currency to the exact copper value for affordability, and re-denominates the remaining balance. It assumes item prices use the standard denomination values and the `system.price.value` plus `system.price.denomination` data fields. It does not apply discounts, taxes, or quantity multipliers.
