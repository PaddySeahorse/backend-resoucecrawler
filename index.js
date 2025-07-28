const express = require('express');
const axios = require('axios');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

// API 端点：解析小红书短链接并提取媒体
app.get('/parse_xiaohongshu', async (req, res) => {
  const { url } = req.query;
  if (!url || !url.includes('xhslink.com')) {
    return res.status(400).json({ error: 'Invalid Xiaohongshu short URL' });
  }

  try {
    // 解析短链接
    const fullUrl = await resolveShortUrl(url);
    if (!fullUrl.includes('xiaohongshu.com')) {
      return res.status(400).json({ error: 'Invalid resolved URL' });
    }

    // 提取媒体链接
    const mediaLinks = await scrapeMedia(fullUrl);
    res.json({ status: 'success', data: { resolvedUrl: fullUrl, media: mediaLinks } });
  } catch (error) {
    res.status(500).json({ error: `Failed to process: ${error.message}` });
  }
});

// 解析短链接
async function resolveShortUrl(shortUrl) {
  const response = await axios.get(shortUrl, {
    maxRedirects: 5,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }
  });
  return response.request.res.responseUrl;
}

// 提取图片和视频链接
async function scrapeMedia(fullUrl) {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  });
  await page.goto(fullUrl, { waitUntil: 'networkidle2' });

  const mediaLinks = { images: [], videos: [] };
  const images = await page.$$eval('img', imgs =>
    imgs.map(img => img.src).filter(src => src.match(/\.(jpg|png|jpeg)$/i))
  );
  mediaLinks.images = images;

  const videos = await page.$$eval('video', vids =>
    vids.map(vid => vid.src).filter(src => src)
  );
  mediaLinks.videos = videos;

  // 捕获动态 API 请求中的媒体 URL
  page.on('response', async response => {
    if (response.url().includes('api') && response.url().includes('json')) {
      try {
        const data = await response.json();
        if (data?.video?.url) {
          mediaLinks.videos.push(data.video.url);
        }
      } catch {}
    }
  });

  await page.waitForTimeout(3000); // 等待动态内容加载
  await browser.close();
  return mediaLinks;
}

module.exports = app;