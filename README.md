# Explain XKCD Bot

This is a NodeJS program which checks the latest xkcd comic, and automatically creates the explainXKCD wiki pages for it.

It uses the `info.0.json` api to collect comic information.

xkcd is queried every 2 minutes, and explainXKCD is queried and updated only when a new comic is released.

The bot automatically logs in to the wiki again every week.

## Usage

`node index <user> <pass>`

## Installation

1. Download or clone this repository.
2. `cd` into the directory
3. Run `npm install`
