# Legacy icon-font authoring sources

These five SVG files were introduced together with the shipped legacy
`emoji.woff` font in commit `653d415bee3200364d396cc65b0b0896d85dbc6d`
("Supply font/svg for all icons, wrong i-icon alignment"). They are not read by
the current HTML, CSS, manifests, tests, or build pipeline. They remain here as
historical authoring sources rather than active tooling assets.

`jslegers-emoji.svg` comes from John Slegers' `emoji-icon-font` project. The
source, copyright notice, and MIT license are recorded in the current
[asset attribution file](../../../../extensions/chromium/runet-censorship-bypass/assets/README.md).
The four `my-circled-information-*` files are the accompanying local icon
alignment variants preserved from the same legacy commit.
