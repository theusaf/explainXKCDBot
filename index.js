const MediaWikiBot = require("mwbot"),
  got = require("got"),
  fs = require("fs"),
  path = require("path"),
  {stripIndent} = require("common-tags"),
  [,,username, password] = process.argv,
  TMP_PATH = path.join(__dirname, "tmp"),
  API_URL = "https://explainxkcd.com/wiki/api.php",
  USER_AGENT = "Netscape Navigator/4.0 (Apple IIGS; 1024x1; x64) Pentium 4 (JavaScript, with Ad Blockers) Boat mode, HIGH-HEAT DRYING DISABLED, explainxkcdBot",
  CURRENT_COMIC_PAGE_ID = "1923",
  REVISIONS_PAGE_ID = "21149",
  CHECK_INTERVAL = 120e3,
  NOT_EXPECTED_CHECK_INTERVAL = 9e5, // 15 minute intervals on days which are not Monday, Wednesday, Friday
  MAX_LOGIN_TIME = 6048e5, // 1 week, to be safe
  MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ],
  REQUEST_OPTION = {
    headers: {
      "User-Agent": USER_AGENT
    }
  },
  EDIT_SUMMARY = "Created by theusafBOT",
  LOGIN_DATA = {
    apiUrl: API_URL,
    username,
    password
  };

if (!fs.statSync(TMP_PATH, {throwIfNoEntry: false})) {
  fs.mkdirSync(TMP_PATH);
}

let expectedComicNumber = null,
  loginTimestamp = 0,
  dateChecked = new Date(0),
  bot = new MediaWikiBot();

function getInterval() {
  const d = new Date,
    day = d.getDay();
  if ((day === 1 || day === 3 || day === 5) && d.getDate() !== dateChecked.getDate()) {
    return CHECK_INTERVAL;
  } else {
    return NOT_EXPECTED_CHECK_INTERVAL;
  }
}

/**
 * login - logs in and starts the updateWiki loop
 */
function login() {
  if (!username || !password) {
    console.log("[ERR] - Usage: node index.js <username> <password>");
    process.exit(0);
  } else {
    bot.loginGetEditToken(LOGIN_DATA).then(() => {
      loginTimestamp = Date.now();
      updateWiki();
    }).catch(err => {
      console.error("[ERR] - Failed to log in");
      console.error(err);
      process.exit(0);
    });
  }
}

/**
 * updateWiki
 * - Fetches information from xkcd and if there is a new comic, create a new page
 * - Runs at an interval of 2 minutes
 */
async function updateWiki() {
  // log in again after a certain amount of time
  if (Date.now() - loginTimestamp > MAX_LOGIN_TIME) {
    console.log("[INFO] - Logging in again");
    bot = new MediaWikiBot();
    login();
    return;
  }
  try {
    // Fetch latest xkcd information
    console.log("[INFO] - Fetching information from xkcd");
    const {body} = await got("https://xkcd.com/info.0.json", REQUEST_OPTION),
      comicData = JSON.parse(body),
      {num, img, day, month, year} = comicData,
      date = `${MONTHS[+month - 1]} ${day}, ${year}`;

    // if expected number is already set, but current number is lower, no need to re-poll explainxkcd, ignore.
    if (expectedComicNumber !== null && expectedComicNumber > num) {
      console.log("[INFO] - No new comic found.");
      setTimeout(updateWiki, getInterval());
      return;
    }

    // Fetching expected xkcd number from explain xkcd.
    console.log("[INFO] - Fetching latest comic on explainxkcd");
    const currentWikiTemplate = await bot.read("Template:LATESTCOMIC"),
      currentRevision = currentWikiTemplate.query.pages[CURRENT_COMIC_PAGE_ID].revisions[0]["*"], // .slots.main["*"],
      expectedNumber = +currentRevision.match(/\d+$/)[0] + 1;

    expectedComicNumber = expectedNumber;

    // if expected number is already set, but current number is lower, no need to create new posts.
    if (expectedComicNumber > num) {
      console.log("[INFO] - No new comic found.");
      setTimeout(updateWiki, getInterval());
      return;
    }

    // Fetch images
    console.log("[INFO] - Fetching images");
    const baseImage = await got(img, REQUEST_OPTION).buffer(),
      imageExtension = comicData.img.match(/(?<=\.)[a-z]+$/)[0],
      imageTitle = comicData.img.match(/(?<=\/comics\/).*?(?=\.[a-z]+$)/)[0];

    createNewExplanation({
      date,
      image: baseImage,
      comicData,
      imageTitle,
      imageExtension
    });

  } catch (err) {
    console.error("[ERR] - Failed to fetch xkcd information. See below for details:");
    console.error(err);
    setTimeout(updateWiki, getInterval() * 2);
  }
}

/**
 * createNewExplanation - Creates and updates the various pages
 */
async function createNewExplanation(info) {
  try {
    const {imageTitle, comicData, imageExtension, image, date} = info,
      {safe_title:comicTitle, alt, num:comicNum} = comicData,
      imagePath = path.join(TMP_PATH, `${imageTitle}.${imageExtension}`);

    // Refresh the edit token to edit/create pages
    await bot.loginGetEditToken(LOGIN_DATA);

    // write image to file system, because the lib doesn't take Buffers...
    fs.writeFileSync(imagePath, image);

    // upload the image
    console.log("[INFO] - Uploading image to explainxkcd");
    await bot.upload(
      `${imageTitle}.${imageExtension}`,
      imagePath,
      `Large size can be found at ${comicData.img.match(/.*?(?=\.[a-z]+$)/)[0]}_2x.${imageExtension}`
    );

    // create/edit redirects
    console.log("[INFO] - Creating redirects");
    await bot.edit(
      comicTitle,
      `#REDIRECT [[${comicNum}: ${comicTitle}]]\n`,
      EDIT_SUMMARY
    );
    await bot.edit(
      `${comicNum}`,
      `#REDIRECT [[${comicNum}: ${comicTitle}]]\n`,
      EDIT_SUMMARY
    );

    // create main page
    console.log("[INFO] - Creating main page");
    await bot.edit(
      `${comicNum}: ${comicTitle}`,
      stripIndent`
      {{comic
      | number    = ${comicNum}
      | date      = ${date}
      | title     = ${comicTitle}
      | image     = ${imageTitle}.${imageExtension}
      | titletext = ${alt}
      }}

      ==Explanation==
      {{incomplete|Created by a BOT - Please change this comment when editing this page. Do NOT delete this tag too soon.}}

      ==Transcript==
      {{incomplete transcript|Do NOT delete this tag too soon.}}
      {{comic discussion}}
      `,
      EDIT_SUMMARY
    );

    // create talk page
    console.log("[INFO] - Creating talk page");
    await bot.edit(
      `Talk:${comicNum}: ${comicTitle}`,
      "<!--Please sign your posts with ~~~~ and don't delete this text. New comments should be added at the bottom.-->",
      EDIT_SUMMARY
    );

    // update latest comic
    console.log("[INFO] - Updating latest comic");
    await bot.edit(
      "Template:LATESTCOMIC",
      `<noinclude>The latest [[xkcd]] comic is number:</noinclude> ${comicNum}`,
      "Changed by theusafBOT"
    );

    // update list of all comics
    console.log("[INFO] - Updating list of comics");
    const allComicsRead = await bot.read("List of all comics"),
      allComicsContent = allComicsRead.query.pages[REVISIONS_PAGE_ID].revisions[0]["*"].split("\n"); // .slots.main["*"].split("\n");
    for (let i = 0; i < allComicsContent.length; i++) {
      if (allComicsContent[i] === "!Date<onlyinclude>") {
        const isoDate = (new Date(date)).toISOString().slice(0, 10);
        allComicsContent.splice(i + 1, 0, `{{comicsrow|${comicNum}|${isoDate}|comicTitle|${imageTitle.replace(/_/g, " ")}.${imageExtension}}}`);
        break;
      }
    }
    await bot.edit(
      "List of all comics",
      allComicsContent.join("\n"),
      "Changed by theusafBOT"
    );

    dateChecked = new Date();
    setTimeout(updateWiki, getInterval());
  } catch (err) {
    console.error("[ERR] - Failed to create explanation. See below for details:");
    console.error(err);
    setTimeout(updateWiki, getInterval() * 2);
  }
}

login();
