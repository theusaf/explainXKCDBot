import MediaWikiBot from "mwbot";
import got from "got";
import sizeOf from "image-size";
import { stripIndent } from "common-tags";

const [, , username, password] = process.argv,
  API_URL = "https://explainxkcd.com/wiki/api.php",
  USER_AGENT =
    "Netscape Navigator/4.0 (Apple IIGS; 1024x1; x64) Pentium 4 (JavaScript, with Ad Blockers) Boat mode, HIGH-HEAT DRYING DISABLED, explainxkcdBot",
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
    "December",
  ],
  REQUEST_OPTION = {
    headers: {
      "User-Agent": USER_AGENT,
    },
  },
  EDIT_SUMMARY = "Created by theusafBOT: ",
  CHANGE_SUMMARY = "Changed by theusafBOT: ",
  LOGIN_DATA = {
    apiUrl: API_URL,
    username,
    password,
  };

let expectedComicNumber = null,
  loginTimestamp = 0,
  dateChecked = new Date(0),
  bot = new MediaWikiBot();

function log(message) {
  console.log(`[${new Date().toISOString()}] - ${message}`);
}

function getInterval() {
  const d = new Date(),
    day = d.getDay();
  if (
    (day === 1 || day === 3 || day === 5) &&
    d.getDate() !== dateChecked.getDate()
  ) {
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
    bot
      .loginGetEditToken(LOGIN_DATA)
      .then(() => {
        loginTimestamp = Date.now();
        updateWiki();
      })
      .catch((err) => {
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
    log("[INFO] - Logging in again");
    bot = new MediaWikiBot();
    login();
    return;
  }
  try {
    // Fetch latest xkcd information
    log("[INFO] - Fetching information from xkcd");
    const { body } = await got("https://xkcd.com/info.0.json", REQUEST_OPTION),
      comicData = JSON.parse(body),
      { num, img, day, month, year } = comicData,
      date = `${MONTHS[+month - 1]} ${day}, ${year}`;

    // if expected number is already set, but current number is lower, no need to re-poll explainxkcd, ignore.
    if (expectedComicNumber !== null && expectedComicNumber > num) {
      log("[INFO] - No new comic found.");
      setTimeout(updateWiki, getInterval());
      return;
    }

    // Fetching expected xkcd number from explain xkcd.
    log("[INFO] - Fetching latest comic on explainxkcd");
    const currentWikiTemplate = await bot.read("Template:LATESTCOMIC"),
      currentRevision =
        currentWikiTemplate.query.pages[CURRENT_COMIC_PAGE_ID].revisions[0][
          "*"
        ],
      expectedNumber = +currentRevision.match(/\d+$/)[0] + 1;

    expectedComicNumber = expectedNumber;

    // if expected number is already set, but current number is lower, no need to create new posts.
    if (expectedComicNumber > num) {
      log("[INFO] - No new comic found.");
      setTimeout(updateWiki, getInterval());
      return;
    }

    // Fetch images
    log("[INFO] - Fetching images");
    const baseImage = await got(img, REQUEST_OPTION).buffer(),
      imageExtension = comicData.img.match(/(?<=\.)[a-z]+$/)[0],
      largeImage = await got(
        `${img.match(/.*?(?=\.[a-z]+$)/)[0]}_2x.${imageExtension}`,
        REQUEST_OPTION,
      )
        .buffer()
        .catch(() => null),
      baseImageSize = sizeOf(baseImage),
      largeImageSize = largeImage ? sizeOf(largeImage) : null,
      imageTitle =
        comicData.img.match(/(?<=\/comics\/).*?(?=\.[a-z]+$)/)[0] +
        (largeImage ? "_2x" : "");

    createNewExplanation({
      date,
      image: largeImage ?? baseImage,
      comicData,
      imageTitle,
      imageExtension,
      baseImageSize,
      largeImageSize,
      is2x: (largeImage ?? baseImage) === largeImage,
    });
  } catch (err) {
    console.error(
      "[ERR] - Failed to fetch xkcd information. See below for details:",
    );
    console.error(err);
    setTimeout(updateWiki, getInterval() * 2);
  }
}

async function isInteractiveComic(number) {
  try {
    const { body } = await got(`https://xkcd.com/${number}`, REQUEST_OPTION);
    return /<script src=".*?\/\d+\/[\/\w\d\s\-_]+?\.js/.test(body);
  } catch (err) {
    return false;
  }
}

/**
 * createNewExplanation - Creates and updates the various pages
 */
async function createNewExplanation(info) {
  try {
    const {
        imageTitle,
        comicData,
        imageExtension,
        image,
        date,
        baseImageSize,
        largeImageSize,
        is2x,
      } = info,
      { safe_title: comicTitle, alt, num: comicNum, transcript } = comicData,
      isInteractiveComicResult = await isInteractiveComic(comicNum);

    // Refresh the edit token to edit/create pages
    bot.editToken = null;
    await bot.getEditToken();

    // upload the image
    log("[INFO] - Uploading image to explainxkcd");
    await bot.upload(
      `${imageTitle}.${imageExtension}`,
      image,
      stripIndent`
      == Summary ==
      ${
        is2x
          ? `Small size can be found at ${
              comicData.img.match(/.*?(?=\.[a-z]+$)/)[0]
            }.${imageExtension}`
          : ""
      }

      == Licensing ==
      {{XKCD file}}
      `,
    );

    // create/edit redirects
    log("[INFO] - Creating redirects");

    // If the comic title is a number underneath the current comic number, do not create this redirect
    if (!/^\d+$/.test(comicTitle) || +comicTitle > comicNum) {
      const comicTitleRedirect = `#REDIRECT [[${comicNum}: ${comicTitle}]]\n`;
      await bot.edit(
        comicTitle,
        comicTitleRedirect,
        `${EDIT_SUMMARY}${comicTitleRedirect}`,
      );
    } else {
      log(
        `[WARN] - Skipped creation of '${comicTitle}' due to lower numerical title`,
      );
    }
    const comicNumRedirect = `#REDIRECT [[${comicNum}: ${comicTitle}]]\n`;
    await bot.edit(
      `${comicNum}`,
      comicNumRedirect,
      `${EDIT_SUMMARY}${comicNumRedirect}`,
    );

    // create main page
    log("[INFO] - Creating main page");
    let sizeString = `${baseImageSize.width}x${baseImageSize.height}px`;
    // Note 2022-02-03
    // If both the 'standard' and '2x' size seem to be the same size
    const isSameSize =
      largeImageSize &&
      baseImageSize.width === largeImageSize.width &&
      baseImageSize.height === largeImageSize.height;
    if (isSameSize) {
      sizeString = `${Math.floor(baseImageSize.width / 2)}x${Math.floor(
        baseImageSize.height / 2,
      )}px`;
    }
    // If the base image size is larger than the large image size, use the large image size / 2
    const isSmallImageLarger =
      largeImageSize &&
      baseImageSize.width > largeImageSize.width &&
      baseImageSize.height > largeImageSize.height;
    if (isSmallImageLarger) {
      sizeString = `${Math.floor(largeImageSize.width / 2)}x${Math.floor(
        largeImageSize.height / 2,
      )}px`;
    }
    await bot.edit(
      `${comicNum}: ${comicTitle}`,
      stripIndent`
      {{comic
      | number    = ${comicNum}
      | date      = ${date}
      | title     = ${comicTitle}
      ${
        sizeString === ""
          ? `| image     = ${imageTitle}.${imageExtension}`
          : `| image     = ${imageTitle}.${imageExtension}
      | imagesize = ${sizeString}
      | noexpand  = true`
      }
      | titletext = ${alt.replace(/\n/g, "<br>")}
      }}${
        isInteractiveComicResult
          ? stripIndent`
          * To experience the interactivity, visit the [https://xkcd.com/${comicNum}/ original comic].
          `
          : ""
      }

      ==Explanation==
      {{incomplete|Created by a BOT - Please change this comment when editing this page. Do NOT delete this tag too soon.}}

      ==Transcript==
      {{incomplete transcript|Do NOT delete this tag too soon.}}
      ${transcript ? transcript + "\n" : ""}
      {{comic discussion}}${
        isInteractiveComicResult
          ? stripIndent`
          [[Category:Interactive comics]]
          `
          : ""
      }
      `,
      `${EDIT_SUMMARY}${comicNum}`,
    );

    // create talk page
    log("[INFO] - Creating talk page");
    await bot.edit(
      `Talk:${comicNum}: ${comicTitle}`,
      stripIndent`
      <!--Please sign your posts with ~~~~ and don't delete this text. New comments should be added at the bottom.-->
      ${
        isSameSize || isSmallImageLarger
          ? `The 'standard' and '2x' sized images had unexpected sizes, so an imagesize parameter has been added to render the image consistently with other comics on this website. See the web [https://web.archive.org/web/*/${imageTitle.replace(
              /_2x$/,
              "",
            )}.${imageExtension} archive] for more details. --~~~~`
          : ""
      }
      `,
      `${EDIT_SUMMARY} talk page for ${comicNum}`,
    );

    // update latest comic
    log("[INFO] - Updating latest comic");
    await bot.edit(
      "Template:LATESTCOMIC",
      `<noinclude>The latest [[xkcd]] comic is number: </noinclude>${comicNum}`,
      `${CHANGE_SUMMARY}${comicNum}`,
    );

    // update list of all comics
    log("[INFO] - Updating list of comics");
    const allComicsRead = await bot.read("List of all comics"),
      allComicsContent =
        allComicsRead.query.pages[REVISIONS_PAGE_ID].revisions[0]["*"].split(
          "\n",
        ); // .slots.main["*"].split("\n");
    for (let i = 0; i < allComicsContent.length; i++) {
      if (allComicsContent[i] === "!Date<onlyinclude>") {
        const isoDate = new Date(date).toISOString().slice(0, 10);
        allComicsContent.splice(
          i + 1,
          0,
          `{{comicsrow|${comicNum}|${isoDate}|${comicTitle}|${imageTitle.replace(
            /_/g,
            " ",
          )}.${imageExtension}}}`,
        );
        break;
      }
    }
    await bot.edit(
      "List of all comics",
      allComicsContent.join("\n"),
      `${CHANGE_SUMMARY}${allComicsContent.length}`,
    );

    dateChecked = new Date();
    setTimeout(updateWiki, getInterval());

    // Archive it!
    try {
      const urls = [
        "https://xkcd.com",
        "https://explainxkcd.com",
        `https://xkcd.com/${comicNum}`,
        `https://explainxkcd.com/${comicNum - 1}`,
        `https://explainxkcd.com/${comicNum}`,
      ];
      for (const url of urls) {
        await got(`https://web.archive.org/save/${url}`);
      }
    } catch (err) {
      /* Ignored */
    }
  } catch (err) {
    console.error(
      "[ERR] - Failed to create explanation. See below for details:",
    );
    console.error(err);
    setTimeout(updateWiki, getInterval() * 2);
  }
}

login();
