const fetch = require('node-fetch');

async function test() {
    try {
        const response = await fetch(`http://127.0.0.1:8000/channel/1424`);
        if (!response.ok) {
            console.log("NOT OK");
            return;
        }
        
        const jsonResp = await response.json();
        console.log(JSON.stringify(jsonResp, null, 2));
        
        if (jsonResp && jsonResp.data && jsonResp.data.length > 0) {
            const data = jsonResp.data[0];
            if (data.url) {
                console.log("URL FOUND:", data.url);
            } else {
                console.log("NO URL IN DATA");
            }
        } else {
            console.log("NO DATA ARRAY");
        }
    } catch (e) {
        console.error(e);
    }
}
test();
