import type {RequestHandler} from "@sveltejs/kit";
import {error, json} from "@sveltejs/kit";
import {env} from "$env/dynamic/private";
import {dev} from "$app/environment";
import {getClosestWan, getUTCDate} from "../../../lib/timeUtils";

const scrapeCacheTime = 5000;
const apiCacheTime = dev ? 30 * 60e3 : 10 * 60e3; // 10 minutes (30 minutes on dev)

// not KV enforced because youtube can handle the tiny bit of extra traffic when the worker restarts
const lastLive = {
    lastCheck: 0,
    isLive: false,
}

// is KV enforced because workers basically never last more than 10 minutes
let liveTitle: {
    lastCheck: number,
    isWAN: boolean,
    started?: string
} = {
    lastCheck: 0,
    isWAN: false
}

let savedStartTime: boolean | undefined = undefined;

export const GET = (async ({platform, fetch}) => {

    const cache = platform?.env?.CACHE;
    const history = platform?.env?.HISTORY;
    if(!cache) throw error(503, "Cache not available");
    if(!history) throw error(503, "History not available");

    if(Date.now() - lastLive.lastCheck < scrapeCacheTime) {
        return json({
            cached: true,
            cachedTitle: false,
            lastFetch: lastLive.lastCheck,
            isLive: lastLive.isLive,
            isWAN: lastLive.isLive && liveTitle.isWAN,
            started: lastLive.isLive ? liveTitle.started : undefined
        })
    }

    lastLive.lastCheck = Date.now();

    const pageData = await fetch("https://www.youtube.com/linustechtips").then(r => r.text());

    const isLive = pageData.includes("\"iconType\":\"LIVE\"");

    lastLive.isLive = isLive;

    if(!isLive) {
        savedStartTime = false;
        return json({
            isLive,
            isWAN: false
        })
    }

    if(Date.now() - liveTitle.lastCheck < apiCacheTime) {
        const newTitleData = await cache.get("wheniswan:youtube:title", {type: "json"})
        if(newTitleData) {
            liveTitle = newTitleData;
        }
    }

    if(Date.now() - liveTitle.lastCheck < apiCacheTime) {
        return json({
            cached: true,
            cachedTitle: true,
            lastFetch: liveTitle.lastCheck,
            isLive,
            isWAN: liveTitle.isWAN,
            started: liveTitle.started
        })
    }

    liveTitle.lastCheck = Date.now();

    const liveData = await fetch(
        "https://www.googleapis.com/youtube/v3/search" +
        "?part=snippet" +
        "&channelId=UCXuqSBlHAE6Xw-yeJA0Tunw" +
        "&maxResults=1" +
        "&order=date" +
        "&type=video" +
        "&eventType=live" +
        "&key=" + env.YOUTUBE_KEY
    ).then(r => r.json());

    const specificData = await fetch("https://www.googleapis.com/youtube/v3/videos" +
        "?part=liveStreamingDetails" +
        "&id=" + liveData.items[0].id.videoId +
        "&maxResults=1" +
        "&order=date" +
        "&type=video" +
        "&eventType=live" +
        "&key=" + env.YOUTUBE_KEY
    ).then(r => r.json())

    if(liveData.items.length == 0) {
        lastLive.lastCheck = Date.now();
        lastLive.isLive = false;
    }

    const isWAN = liveData.items[0].snippet.title.includes("WAN");
    const started = specificData.items[0].liveStreamingDetails.actualStartTime;

    if(!savedStartTime && isWAN) {
        const kvStartTime = await history.get(getUTCDate(getClosestWan()) + ":mainShowStart");
        if(!kvStartTime) {
            await history.put(getUTCDate(getClosestWan()) + ":mainShowStart", started, {
                // Expire this key after 15 days to save space over time.
                // It should be collapsed into a single object at the end of the stream, so no data should be lost.\
                // The collapsing is done in a scheduled worker
                expirationTtl: 15 * 24 * 60 * 60
            });
        }
        savedStartTime = true;
    }

    liveTitle.isWAN = isWAN;
    liveTitle.started = started;

    await cache.put("wheniswan:youtube:title", JSON.stringify(liveTitle));

    return json({
        isLive,
        isWAN,
        started
    })


}) satisfies RequestHandler;