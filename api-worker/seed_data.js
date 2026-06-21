const chunkedData = {
    interactions: [
        {
            id: "fda_001",
            text: "Paracetamol (Acetaminophen) mixed with Warfarin can significantly increase the bleeding risk by prolonging the prothrombin time."
        },
        {
            id: "fda_002",
            text: "Lisinopril interacting with Ibuprofen (NSAID) reduces the antihypertensive effect and increases the risk of severe renal impairment."
        },
        {
            id: "fda_003",
            text: "Sildenafil mixed with Nitroglycerin causes a severe, potentially fatal drop in blood pressure. Absolute contraindication."
        },
        {
            id: "fda_004",
            text: "Cetirizine and Paracetamol have no known severe interactions and are generally safe to take together for cold symptoms."
        }
    ]
};

async function ingestData() {
    console.log("Starting Vector and D1 Ingestion...");
    try {
        const response = await fetch("http://127.0.0.1:8787/api/ingest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(chunkedData)
        });
        const result = await response.json();
        console.log("Ingestion Complete:", result);
    } catch (err) {
        console.error("Failed to connect to local worker. Is it running?", err);
    }
}

ingestData();