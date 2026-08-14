# TradingView Economic Calendar for Notion

A minimal GitHub Pages wrapper for TradingView's official Economic Calendar widget.
It is designed to replace an Apption-hosted embed in Notion without exposing any
investment-workbench, account, or trading data.

## Default view

- United States events only
- High-importance events only
- English event labels
- Automatic light/dark theme
- Responsive width for a Notion embed block
- TradingView attribution preserved

## Notion embed

Paste this URL into Notion and select **Create embed**:

```text
https://v2-mason.github.io/tradingview-economic-calendar-notion/
```

Resize the Notion embed block to roughly 500–700 px high. The hosted page is public,
but contains no personal or portfolio data.

## Optional URL settings

The defaults can be changed with query parameters:

```text
?theme=dark
?locale=zh_CN
?importance=medium-high
?importance=all
?countries=us,hk,cn
```

Example:

```text
https://v2-mason.github.io/tradingview-economic-calendar-notion/?theme=dark&locale=en&importance=high&countries=us
```

## Data boundary

This page is a display-only reference layer. TradingView supplies and updates the
widget data. The page does not scrape the widget, persist events, provide an API,
or write data into Notion or the investment workbench. Events used for governed
investment decisions should still be verified against their original official
sources and recorded in the governed event calendar.

TradingView's widget terms and attribution requirements continue to apply.
