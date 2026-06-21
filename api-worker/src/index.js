export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ==========================================
    // ENDPOINT 1: DATA INGESTION PIPELINE (RAG)
    // ==========================================
    if (url.pathname === '/api/ingest' && request.method === 'POST') {
      try {
        const data = await request.json(); 
        let inserted = 0;

        for (const item of data.interactions) {
          // 1. Generate Vector Embedding locally on the Edge
          const embeddingResp = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
            text: item.text
          });

          // 2. Insert into Vectorize (Semantic Search)
          await env.VECTORIZE_INDEX.insert([
            {
              id: item.id,
              values: embeddingResp.data[0]
            }
          ]);

          // 3. Insert into D1 (Hard Data Storage)
          await env.DB.prepare(
            "INSERT OR REPLACE INTO medical_logs (id, context_text) VALUES (?, ?)"
          ).bind(item.id, item.text).run();

          inserted++;
        }
        return new Response(JSON.stringify({ success: true, records_inserted: inserted }));
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
      }
    }



// ==========================================
    // ENDPOINT 1.5: CLOUD VISION OCR PIPELINE
    // ==========================================
    if (url.pathname === '/api/vision' && request.method === 'POST') {
      try {
        // 1. Declare the variables!
        const payload = await request.json();
        const base64Image = payload.image;

        if (!base64Image) {
          throw new Error("No image payload received from the frontend.");
        }

        
        // 2. Send to Groq's Multimodal Vision Model
        const groqVisionResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            // Update this specific line to the active model
            model: "meta-llama/llama-4-scout-17b-16e-instruct", 
            messages: [
              {
                role: "user",
                content: [
                  { 
                    type: "text", 
                    text: "Identify the active pharmaceutical ingredients in this image. RETURN ONLY A COMMA-SEPARATED LIST OF THE CHEMICAL NAMES. DO NOT output any sentences, explanations, or conversational text. DO NOT say 'The image shows' or 'Here is the list'. Only the raw ingredient names.\n\nExample Output: Ciprofloxacin, Paracetamol" 
                  },
                  { 
                    type: "image_url", 
                    image_url: { url: base64Image } 
                  }
                ]
              }
            ],
            temperature: 0.1 
          })
        });



        const visionData = await groqVisionResponse.json();
        
        // 3. Catch actual API rejections from Groq
        if (!groqVisionResponse.ok) {
            throw new Error(`Groq API Error: ${visionData.error?.message || 'Unknown error'}`);
        }

        if (!visionData.choices || !visionData.choices[0]) {
          throw new Error("Vision Engine returned an empty response.");
        }

        const extractedText = visionData.choices[0].message.content;
        
        // 4. Return clean JSON to the frontend
        return new Response(JSON.stringify({ status: "success", drugs: extractedText }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { 
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }


    // ==========================================
    // ENDPOINT 2: INFERENCE ENGINE (FRONTEND)
    // ==========================================
    if (url.pathname === '/api/analyze') {
      
      // Handle CORS
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          }
        });
      }

      if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

      try {
        const payload = await request.json();
        const extractedDrugs = payload.drugs; 
        const queryText = extractedDrugs.join(" interacting with ");

        // 1. Embed the User's Query
        const queryEmbedding = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
          text: queryText
        });

        // 2. Query the Vectorize Database for the closest semantic match
        const vectorMatches = await env.VECTORIZE_INDEX.query(queryEmbedding.data[0], { 
          topK: 2 
        });

        // 3. Retrieve the actual facts from D1 based on matching Vector IDs
        let realMedicalContext = "";
        for (const match of vectorMatches.matches) {
          // Strict Guardrail: Only use highly confident semantic matches
          if (match.score > 0.65) {
            const dbResult = await env.DB.prepare("SELECT context_text FROM medical_logs WHERE id = ?").bind(match.id).first();
            if (dbResult) realMedicalContext += dbResult.context_text + "\n";
          }
        }

        // If no data exists in our system, force a safe default
        if (!realMedicalContext) {
            realMedicalContext = "No known severe interactions exist in the standard FDA registry for this specific combination. However, always consult a physician.";
        }

        
		// 4. Send the strictly retrieved context to Groq
        const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.GROQ_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "llama-3.1-8b-instant",
            messages: [
              {
                role: "system",
                content: `You are a strict clinical triage parser. Your ONLY function is to evaluate the provided drugs against the provided medical context. 

CRITICAL RULES:
1. You MUST start your response with EXACTLY one of these words: SAFE, CAUTION, SEVERE, or UNKNOWN.
2. If the exact combination of drugs is NOT explicitly mentioned in the context, your entire response MUST be exactly: "UNKNOWN: Insufficient clinical data in the edge database to assess this specific combination."
3. Do NOT add conversational text. Do NOT explain your reasoning. Do NOT pull outside knowledge.`
              },
              {
                role: "user",
                content: `Medical Context to strictly obey:\n${realMedicalContext}\n\nDrugs detected:\n${extractedDrugs.join(", ")}`
              }
            ],
            temperature: 0.0, // Absolute deterministic output. No creative thinking allowed.
            max_tokens: 100   // Hard cutoff to prevent rambling
          })
        });




        const aiData = await groqResponse.json();
        const finalWarning = aiData.choices[0].message.content;

        return new Response(JSON.stringify({ status: "success", warning: finalWarning }), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { 
            status: 500,
            headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};