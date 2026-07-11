export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
    };

    const url = new URL(request.url);

    // Endpoint: POST /ping
    if (request.method === "POST" && url.pathname === "/ping") {
      try {
        const body = await request.json();
        const id = body.installation_id;
        if (!id) {
          return new Response("Missing installation_id", { status: 400, headers: corsHeaders });
        }

        const key = `ping:${id}`;
        
        let data = { pings: 0 };
        const existingStr = await env.TELEMETRY_KV.get(key);
        if (existingStr) {
          try {
            data = JSON.parse(existingStr);
          } catch (e) {}
        }

        const now = new Date().toISOString();
        data.installation_id = id;
        data.pings = (data.pings || 0) + 1;
        // Set once, on the very first ping from this device — never overwritten
        // after. This is what lets /stats tell new installs from returning ones.
        if (!data.first_seen) data.first_seen = now;
        data.last_ping = now;
        if (body.os) data.os = body.os;
        if (body.version) data.version = body.version;

        await env.TELEMETRY_KV.put(key, JSON.stringify(data));

        return new Response(JSON.stringify({ status: "ok" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (err) {
        return new Response("Bad Request", { status: 400, headers: corsHeaders });
      }
    }

    // Endpoint: GET /stats
    if (request.method === "GET" && url.pathname === "/stats") {
      if (env.ADMIN_SECRET && url.searchParams.get("secret") !== env.ADMIN_SECRET) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders });
      }

      try {
        let cursor = "";
        let totalInstalls = 0;
        let totalPings = 0;
        let osCounts = {};
        let newInstalls = 0;
        let returningInstalls = 0;
        let dormantInstalls = 0;

        const now = Date.now();
        const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

        while (true) {
          const listOpts = { prefix: "ping:" };
          if (cursor) listOpts.cursor = cursor;

          const result = await env.TELEMETRY_KV.list(listOpts);
          totalInstalls += result.keys.length;

          for (const keyObj of result.keys) {
            const val = await env.TELEMETRY_KV.get(keyObj.name);
            if (val) {
              try {
                const parsed = JSON.parse(val);
                totalPings += (parsed.pings || 1);
                const os = parsed.os || "unknown";
                osCounts[os] = (osCounts[os] || 0) + 1;

                // New vs. returning vs. dormant, based on first_seen / last_ping.
                // Rough signal only: a ping means the backend started (e.g. PC
                // booted with autostart on), not that anyone opened WAgent.
                const firstSeen = parsed.first_seen ? Date.parse(parsed.first_seen) : now;
                const lastPing = parsed.last_ping ? Date.parse(parsed.last_ping) : now;
                const isNew = now - firstSeen < SEVEN_DAYS_MS;
                const activeRecently = now - lastPing < SEVEN_DAYS_MS;
                if (isNew) {
                  newInstalls++;
                } else if (activeRecently) {
                  returningInstalls++;
                } else {
                  dormantInstalls++;
                }
              } catch (e) {}
            }
          }

          if (result.list_complete) {
            break;
          }
          cursor = result.cursor;
        }

        return new Response(JSON.stringify({
          total_installations: totalInstalls,
          total_pings: totalPings,
          os_counts: osCounts,
          new_installs_7d: newInstalls,
          returning_installs: returningInstalls,
          dormant_installs: dormantInstalls,
          note: "new/returning/dormant is a rough proxy from backend restarts (e.g. PC boot via autostart), not confirmed in-app usage."
        }, null, 2), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(err.message, { status: 500, headers: corsHeaders });
      }
    }

    return new Response("WAgent Telemetry Receiver", { status: 200, headers: corsHeaders });
  },
};
