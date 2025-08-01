require("dotenv").config();
const { chromium } = require("playwright");
const xlsx = require("xlsx");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");
const nodemailer = require("nodemailer");

let scrapedData = [];
let isScrapingCancelled = false;
let cookieStore = [];

function validateCarName(carName) {
  if (!carName || carName.length < 1) {
    return {
      valid: false,
      message: `Car name "${carName}" must be at least 1 characters long`,
    };
  }

  return { valid: true };
}

function formatCarNameForUrl(carName) {
  return carName.toLowerCase().replace(/\s+/g, "/");
}

function formatCarNameForFile(carName) {
  return carName.toLowerCase().replace(/\s+/g, "_").replace(/\//g, "_");
}

function sanitizeFileName(str) {
  return str
    .replace(/[^a-zA-Z0-9-_]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 100);
}

async function scrapeCarData(
  page,
  carName,
  periodName,
  selectors,
  durationHours,
  isMonthly,
  mainUrl
) {
  try {
    let index = 0;
    let results = [];
    const maxRetries = 1;

    while (true) {
      if (isScrapingCancelled) throw new Error("Scraping cancelled by user");

      console.log(
        `Loading main page for car ${index + 1} in ${carName} (${periodName})`
      );
      await page.goto(mainUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });

      try {
        await page.waitForSelector(selectors.title, {
          state: "visible",
          timeout: 5000,
        });
        await page.waitForSelector(selectors.features, {
          state: "visible",
          timeout: 5000,
        });
        await page.waitForSelector(selectors.price, {
          state: "visible",
          timeout: 5000,
        });
        console.log(`Car cards loaded for ${carName} (${periodName})`);
      } catch (error) {
        console.warn(
          `No car cards found for ${carName} (${periodName}): ${error.message}`
        );
        break;
      }

      let retryCount = 0;
      let cardData = null;
      while (retryCount < maxRetries) {
        try {
          cardData = await page.evaluate(
            ({
              index,
              carName,
              periodName,
              selectors,
              durationHours,
              isMonthly,
            }) => {
              const carElements = document.querySelectorAll(selectors.title);
              const featureDivs = document.querySelectorAll(selectors.features);
              const priceDivs = document.querySelectorAll(selectors.price);
              const buttonElements = document.querySelectorAll(
                selectors.button
              );

              console.log(
                `Found ${buttonElements.length} buttons with selector ${selectors.button}`
              );

              if (index >= 5) return null;

              const data = {};
              const carElement = carElements[index];
              data["Car Name"] = carElement.textContent.trim() || "N/A";

              const ancestorContainer = carElement.closest("div");
              if (!ancestorContainer) return null;

              const modelElement = ancestorContainer.querySelector(
                selectors.model
              );
              data["Model"] = modelElement
                ? modelElement.textContent.trim()
                : "N/A";
              const yearMatch = data["Model"].match(/\d{4}/);
              data["Year"] = yearMatch ? yearMatch[0] : "N/A";

              const featureDiv = featureDivs[index];
              if (featureDiv) {
                const spanElements = featureDiv.querySelectorAll(
                  selectors.featureSpans
                );
                const featureTexts = Array.from(spanElements)
                  .map((span) => span.textContent.trim())
                  .filter((text) => text);
                data["Description"] =
                  featureTexts.length > 0 ? featureTexts.join(", ") : "N/A";
                data["Description"] = data["Description"]
                  .replace(/\s+/g, " ")
                  .trim();
              } else {
                data["Description"] = "N/A";
              }

              const priceDiv = priceDivs[index];
              if (priceDiv) {
                const pElements = priceDiv.querySelectorAll("p");
                let crossPrice = "N/A";
                let actualPrice = "N/A";
                let totalPrice = "N/A";

                pElements.forEach((p) => {
                  const text = p.textContent.trim();

                  if (/Total:/i.test(text)) {
                    totalPrice = text.replace("Total:", "").trim();
                  } else if (
                    /AED/.test(text) &&
                    p.querySelector(".Price_crossOut__QufS3")
                  ) {
                    crossPrice = text;
                  } else if (/AED/.test(text)) {
                    actualPrice = text;
                  }
                });

                data["Cross Price"] = crossPrice;
                data["Actual Price"] = actualPrice;
                data["Total"] = totalPrice;
              } else {
                data["Cross Price"] = "N/A";
                data["Actual Price"] = "N/A";
                data["Total"] = "N/A";
              }

              data["Original Vehicle"] = carName;
              data["Period"] = periodName;

              return { data, hasButton: !!buttonElements[index] };
            },
            { index, carName, periodName, selectors, durationHours, isMonthly }
          );

          if (cardData) break;
          console.log(
            `Retrying card ${
              index + 1
            } for ${carName} (${periodName}), attempt ${retryCount + 1}`
          );
          await page.waitForTimeout(2000);
          retryCount++;
        } catch (error) {
          console.error(`Error evaluating card ${index + 1}: ${error.message}`);
          retryCount++;
        }
      }

      if (!cardData) {
        console.log(
          `No more cards found for ${carName} (${periodName}) at index ${index}`
        );
        break;
      }

      results.push(cardData.data);

      if (cardData.hasButton) {
        const buttonSelector = selectors.button;
        try {
          const button = await page.locator(buttonSelector).nth(index).first();
          await button.scrollIntoViewIfNeeded();
          await button.waitFor({ state: "visible", timeout: 2000 });
          console.log(
            `Clicking View Deal for car ${
              index + 1
            } in ${carName} (${periodName})`
          );
          await button.click({ timeout: 3000 });
          await page.waitForTimeout(2000);

          await page
            .waitForSelector('div[class*="Island_IslandWrap__QuZPl"]', {
              state: "visible",
              timeout: 3000,
            })
            .catch(() => {
              console.warn(`Mileage section not found for car ${index + 1}`);
            });

          const mileage = await page.evaluate(() => {
            const mileageSection = Array.from(
              document.querySelectorAll(
                'div[class*="Island_IslandWrap__QuZPl"]'
              )
            ).find((section) =>
              section
                .querySelector("h3")
                ?.textContent.toLowerCase()
                .includes("mileage")
            );

            if (!mileageSection) return "N/A";

            const titles = Array.from(
              mileageSection.querySelectorAll(
                'div[class*="SlotText_Title__gHEmU"]'
              )
            ).map((el) => el.textContent.trim());

            const subtitles = Array.from(
              mileageSection.querySelectorAll(
                'div[class*="SlotText_Subtitle__yHTPE"]'
              )
            ).map((el) => el.textContent.trim());

            const combined = [...titles, ...subtitles].join(" ");

            const kmMatch = combined.match(/([\d,]+)\s*km/i);
            const priceMatch = combined.match(/AED\s?(\d+(\.\d+)?)/i);

            const km = kmMatch ? kmMatch[1].replace(/,/g, "") : null;
            const price = priceMatch ? priceMatch[1] : null;

            if (km && price) {
              return `${km} km, then ${price} AED per km`;
            }

            return "N/A";
          });

          const insuranceOptions = await page.evaluate(() => {
            const insuranceSection = document.querySelector(
              'div[class*="BookFormInsuranceOptions_island__"]'
            );
            if (!insuranceSection) return "N/A";

            const rawText = insuranceSection.innerText || "";
            const lines = rawText
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean);

            const result = [];

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];

              if (line.includes("Comprehensive Insurance")) {
                result.push(line);
              }

              if (/excess amount.*\d+.*AED/i.test(line)) {
                result.push(line);
              }

              if (/deposit[- ]free ride.*AED/i.test(line)) {
                result.push(line);
              }

              if (
                line.toLowerCase() === "deposit" &&
                lines[i + 1]?.includes("AED")
              ) {
                result.push(` or ${line} ${lines[i + 1]}`);
              }
            }

            return result.length ? result.join("\n") : "N/A";
          });

          console.log(
            `Scraped second page for car ${
              index + 1
            }: Mileage="${mileage}", Insurance="${insuranceOptions}"`
          );

          results[index]["Mileage"] = mileage;
          results[index]["Insurance & Options"] = insuranceOptions;

          cookieStore = await page.context().cookies();
        } catch (error) {
          console.error(
            `Error on second page for car ${index + 1}: ${error.message}`
          );
          results[index]["Mileage"] = "N/A";
          results[index]["Insurance & Options"] = "N/A";
        }
      } else {
        console.log(`No View Deal button found for car ${index + 1}`);
        results[index]["Mileage"] = "N/A";
        results[index]["Insurance & Options"] = "N/A";
      }

      index++;
    }

    if (results.length === 0) {
      console.log(`No data scraped for ${carName} (${periodName})`);
      return {
        success: false,
        message: `No data found for ${carName} (${periodName})`,
        data: [],
      };
    }

    return { success: true, data: results };
  } catch (error) {
    let message = error.message.includes("timeout")
      ? "Check car name on Yango Drive website"
      : error.message.includes("cancelled")
      ? "Scraping cancelled by user"
      : error.message;
    return { success: false, message, data: [] };
  }
}

async function scrapeCars(
  carNames,
  dailyCheck,
  weeklyCheck,
  monthlyCheck,
  monthlyData
) {
  const errors = [];
  for (const carName of carNames) {
    const validation = validateCarName(carName);
    if (!validation.valid) errors.push(validation.message);
  }
  if (errors.length > 0) return { success: false, message: errors.join("; ") };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.setExtraHTTPHeaders({
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  });

  const selectors = {
    title: 'span[class*="Card_CardTitleMedium__korrS"]',
    features: 'div[class*="HStack_HStack__bHoaj Card_CardBubbles__zuOuw"]',
    price: 'div[class*="Heading_Heading__PjLg8 Card_CardPrice__spWUR"]',
    model: 'span[class*="ButtonSimilarInfo_ButtonSimilarInfoPrefix___Qou3"]',
    featureSpans: 'span[class*="Text_Text__F4Wpv Card_CardBubble__zukT3"]',
    button: 'button[data-testid="Card.Book"]',
  };

  // Use current date and time
  const now = new Date();
  now.setHours(now.getHours() + 2); // Adds 2 hours

  const pickupDate = now.toISOString().split("T")[0]; // YYYY-MM-DD
  const baseTime = now.toTimeString().split(" ")[0]; // HH:MM:SS

  try {
    for (const carName of carNames) {
      if (isScrapingCancelled)
        return { success: false, message: "Scraping cancelled" };
      const formattedCarName = formatCarNameForUrl(carName.toLowerCase());

      const page = await context.newPage();
      try {
        // Daily rental: Current date + 1 day
        if (dailyCheck) {
          const sinceDateTime = new Date(`${pickupDate}T${baseTime}`).getTime();
          const untilDate = new Date(pickupDate);
          untilDate.setDate(untilDate.getDate() + 1); // Add 1 day
          const untilDateTime = new Date(
            `${untilDate.toISOString().split("T")[0]}T${baseTime}`
          ).getTime();
          const durationHours =
            (untilDateTime - sinceDateTime) / (1000 * 60 * 60);
          const periodName = `${new Date(
            sinceDateTime
          ).toLocaleString()} - ${new Date(untilDateTime).toLocaleString()}`;
          const isMonthly = durationHours >= 720;
          const durationMonths = isMonthly ? Math.ceil(durationHours / 720) : 0;
          const mainUrl = `https://drive.yango.com/search/all/${formattedCarName}?since=${sinceDateTime}&until=${untilDateTime}&duration_months=${durationMonths}${
            isMonthly ? "&is_monthly=true" : ""
          }&sort_by=price&sort_order=asc`;
          const result = await scrapeCarData(
            page,
            carName,
            periodName,
            selectors,
            durationHours,
            isMonthly,
            mainUrl
          );
          if (result.success) scrapedData = scrapedData.concat(result.data);
          else
            errors.push(
              `Daily scrape failed for ${carName}: ${result.message}`
            );
        }

        // Weekly rental: Current date + 7 days
        if (weeklyCheck) {
          const sinceDateTime = new Date(`${pickupDate}T${baseTime}`).getTime();
          const untilDate = new Date(pickupDate);
          untilDate.setDate(untilDate.getDate() + 7); // Add 7 days
          const untilDateTime = new Date(
            `${untilDate.toISOString().split("T")[0]}T${baseTime}`
          ).getTime();
          const durationHours =
            (untilDateTime - sinceDateTime) / (1000 * 60 * 60);
          const periodName = `${new Date(
            sinceDateTime
          ).toLocaleString()} - ${new Date(untilDateTime).toLocaleString()}`;
          const isMonthly = durationHours >= 720;
          const durationMonths = isMonthly ? Math.ceil(durationHours / 720) : 0;
          const mainUrl = `https://drive.yango.com/search/all/${formattedCarName}?since=${sinceDateTime}&until=${untilDateTime}&duration_months=${durationMonths}${
            isMonthly ? "&is_monthly=true" : ""
          }&sort_by=price&sort_order=asc`;
          const result = await scrapeCarData(
            page,
            carName,
            periodName,
            selectors,
            durationHours,
            isMonthly,
            mainUrl
          );
          if (result.success) scrapedData = scrapedData.concat(result.data);
          else
            errors.push(
              `Weekly scrape failed for ${carName}: ${result.message}`
            );
        }

        // Monthly rental: Use monthly URL with is_monthly=true
        if (monthlyCheck && monthlyData.months) {
          const sinceDateTime = new Date(`${pickupDate}T${baseTime}`).getTime();
          const untilDate = new Date(pickupDate);
          untilDate.setMonth(untilDate.getMonth() + monthlyData.months); // Add months
          const untilDateTime = new Date(
            `${untilDate.toISOString().split("T")[0]}T${baseTime}`
          ).getTime();
          const durationHours =
            (untilDateTime - sinceDateTime) / (1000 * 60 * 60);
          const periodName = `${monthlyData.months} Month${
            monthlyData.months > 1 ? "s" : ""
          } from ${new Date(sinceDateTime).toLocaleString()}`;
          const mainUrl = `https://drive.yango.com/search/all/${formattedCarName}?since=${sinceDateTime}&until=${untilDateTime}&duration_months=${monthlyData.months}&is_monthly=true&sort_by=price&sort_order=asc`;
          const result = await scrapeCarData(
            page,
            carName,
            periodName,
            selectors,
            durationHours,
            true,
            mainUrl
          );
          if (result.success) scrapedData = scrapedData.concat(result.data);
          else
            errors.push(
              `Monthly scrape failed for ${carName}: ${result.message}`
            );
        }
      } catch (error) {
        errors.push(`Failed to scrape ${carName}: ${error.message}`);
      } finally {
        await page.close();
      }
    }

    if (scrapedData.length === 0) {
      return {
        success: false,
        message: errors.length > 0 ? errors.join("; ") : "No data scraped",
      };
    }

    return {
      success: true,
      message:
        errors.length > 0
          ? `Scraping completed with errors: ${errors.join("; ")}`
          : "Scraping completed successfully",
      data: scrapedData,
    };
  } catch (error) {
    return { success: false, message: error.message };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function generateExcelFile(data, carNames) {
  const worksheet = xlsx.utils.json_to_sheet(data);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Car Data");

  let fileNameParts = [];
  if (carNames && carNames.length > 0 && carNames[0] !== "") {
    fileNameParts.push(carNames.map(formatCarNameForFile).join("_"));
  } else {
    fileNameParts.push("all_cars");
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `car_data_${fileNameParts.join("_")}_${timestamp}.xlsx`;

  const tempDir = path.join(__dirname, "temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  const filePath = path.join(tempDir, fileName);
  xlsx.writeFile(workbook, filePath);

  return { filePath, fileName };
}

async function sendEmailWithAttachment(filePath, fileName, recipientEmail) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
    debug: true,
  });

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: recipientEmail,
    subject: `Yango Drive Data Scrape - ${new Date().toLocaleString()}`,
    text: "Attached is the scraped Yango drive  in excel format.",
    attachments: [
      {
        filename: fileName,
        path: filePath,
      },
    ],
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email sent with attachment ${fileName} to ${recipientEmail}`);
    return { success: true, message: "Email sent successfully" };
  } catch (error) {
    console.error(`Error sending email: ${error.message}`);
    return {
      success: false,
      message: `Failed to send email: ${error.message}`,
    };
  }
}

async function runScheduledScrape() {
  const carNames = [
    "exeed lx",
    "jac j7",
    "jac js4",
    "kaiyi x3",
    "kia pegas",
    "kia seltos",
    "kia sonet",
    "mg 3",
    "mg 5",
    "mg gt",
    "mitsubishi asx",
    "mitsubishi attrage",
    "mitsubishi xpander",
    "nissan kicks",
    "nissan sunny",
    "suzuki ciaz",
    "suzuki dzire",
  ]; // Replace with your car names
  const dailyCheck = true;
  const weeklyCheck = true;
  const monthlyCheck = true;
  const monthlyData = { months: 1 }; // Example: 1 month for monthly rental
  const recipientEmail = process.env.RECIPIENT_EMAIL.split(",");

  console.log(`Starting scheduled scrape at ${new Date().toLocaleString()}`);

  scrapedData = []; // Reset scrapedData
  isScrapingCancelled = false;

  const result = await scrapeCars(
    carNames,
    dailyCheck,
    weeklyCheck,
    monthlyCheck,
    monthlyData
  );

  if (result.success && result.data.length > 0) {
    const { filePath, fileName } = await generateExcelFile(
      result.data,
      carNames
    );
    const emailResult = await sendEmailWithAttachment(
      filePath,
      fileName,
      recipientEmail
    );

    // Clean up the file
    fs.unlink(filePath, (err) => {
      if (err) console.error(`Error deleting temp file ${filePath}: ${err}`);
    });

    if (!emailResult.success) {
      console.error(`Failed to send email: ${emailResult.message}`);
    }
  } else {
    console.error(`Scraping failed: ${result.message}`);
    const transporter = nodemailer.createTransport({
      service: "gmail",
      port: 587,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: recipientEmail,
      subject: `Car Data Scrape Failed - ${new Date().toLocaleString()}`,
      text: `Scraping failed with message: ${result.message}`,
    };

    await transporter.sendMail(mailOptions).catch((err) => {
      console.error(`Error sending failure email: ${err.message}`);
    });
  }
}

// Schedule the scrape to run at 8 AM and 4 PM daily (IST)
process.env.TZ = "Asia/Kolkata"; // Set time zone to IST
console.log("scrapper will run on set timing...")
cron.schedule("0 11 * * *", () => {
  console.log("Running scheduled scrape at 8 AM IST");
  runScheduledScrape();
});

cron.schedule("0 16 * * *", () => {
  console.log("Running scheduled scrape at 4 PM IST");
  runScheduledScrape();
});

