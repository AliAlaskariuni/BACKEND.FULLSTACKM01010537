// Loads the configuration from config.env to process.env
require("dotenv").config({ path: "./config.env" });
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let db;

async function connectToMongoDB() {
    try {
        await client.connect();
        db = client.db("lesson_store");
        console.log("You successfully connected to MongoDB!");
    } catch (err) {
        console.error("MongoDB connection failed:", err);
        throw err;
    }
}

var express = require("express"); // Requires the Express module
const port = process.env.PORT || 3000; // Sets the port to the value in the environment variable PORT, or 3000 if not set
// Calls the express function to start a new Express application
var app = express();
var cors = require("cors");

// tracks incoming requests
app.use(function (request, response, next) {
    console.log("Incoming " + request.method + " request for " + request.url);
    next();
});

app.use(cors());
app.use(express.json());
app.use("/images", express.static(path.join(__dirname, "images")));
app.use("/images", function (request, response) {
    response.status(404).json({ error: "Image not found" });
});

// GET /lessons - returns all lessons from MongoDB for the front end
app.get("/lessons", async function (request, response) {
    try {
        const results = await db.collection("lessons").find({}).toArray();
        response.json(results);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// GET /search - searches lesson text and numeric fields
app.get("/search", async function (request, response) {
    try {
        const searchTerm = String(request.query.q || "").trim();

        if (searchTerm === "") {
            const results = await db.collection("lessons").find({}).toArray();
            return response.json(results);
        }

        const escapedSearchTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const results = await db.collection("lessons").find({
            $or: [
                { subject: new RegExp(escapedSearchTerm, "i") },
                { location: new RegExp(escapedSearchTerm, "i") },
                {
                    $expr: {
                        $regexMatch: {
                            input: { $toString: { $ifNull: ["$price", ""] } },
                            regex: escapedSearchTerm,
                            options: "i"
                        }
                    }
                },
                {
                    $expr: {
                        $regexMatch: {
                            input: { $toString: { $ifNull: ["$availability", ""] } },
                            regex: escapedSearchTerm,
                            options: "i"
                        }
                    }
                }
            ]
        }).toArray();

        response.json(results);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// GET /teachers - returns teachers and their assigned lessons
app.get("/teachers", async function (request, response) {
    try {
        const results = await db.collection("teachers")
            .find({})
            .sort({ lastName: 1, firstName: 1 })
            .toArray();
        response.json(results);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// turns the :_id in the url into a MongoDB ObjectId, or null if it is not a valid id
function toObjectId(id) {
    return ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : null;
}

// GET /lessons/:_id - returns one lesson
app.get("/lessons/:_id", async function (request, response) {
    try {
        const _id = toObjectId(request.params._id);
        if (!_id) return response.status(400).json({ error: "Invalid lesson id" });

        const lesson = await db.collection("lessons").findOne({ _id: _id });
        if (!lesson) return response.status(404).json({ error: "Lesson not found" });
        response.json(lesson);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// PUT /lessons/:_id - updates the fields sent in the body (e.g. availability, price)
app.put("/lessons/:_id", async function (request, response) {
    try {
        const _id = toObjectId(request.params._id);
        if (!_id) return response.status(400).json({ error: "Invalid lesson id" });

        const updates = Object.assign({}, request.body);
        delete updates._id; // the MongoDB id can't be changed
        if (Object.keys(updates).length === 0) {
            return response.status(400).json({ error: "Nothing to update" });
        }

        const result = await db.collection("lessons").updateOne({ _id: _id }, { $set: updates });
        if (result.matchedCount === 0) return response.status(404).json({ error: "Lesson not found" });
        response.json(result);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// POST /lessons/reset - puts every lesson back to 5 spaces (called when the site is opened)
app.post("/lessons/reset", async function (request, response) {
    try {
        await db.collection("lessons").updateMany({}, { $set: { availability: 5 } });
        response.json({ message: "Lesson availability reset" });
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// POST /orders - validates an order, saves it, and reduces lesson availability
app.post("/orders", async function (request, response) {
    try {
        const { name, phone, lessonIds, spaces } = request.body;

        if (
            typeof name !== "string" ||
            !/^[A-Za-z]+$/.test(name) ||
            typeof phone !== "string" ||
            !/^\d{11}$/.test(phone) ||
            !Array.isArray(lessonIds) ||
            lessonIds.length === 0 ||
            !spaces ||
            typeof spaces !== "object" ||
            Array.isArray(spaces)
        ) {
            return response.status(400).json({
                error: "Use a letters-only name, an 11-digit phone number, lesson IDs and lesson quantities"
            });
        }

        const lessons = db.collection("lessons");

        const counts = {};
        lessonIds.forEach(function (id) {
            counts[id] = (counts[id] || 0) + 1;
        });

        const spaceIds = Object.keys(spaces);
        if (spaceIds.length === 0 || spaceIds.length !== Object.keys(counts).length) {
            return response.status(400).json({ error: "Lesson quantities do not match the cart" });
        }

        for (const id of spaceIds) {
            const quantity = spaces[id];
            if (
                !Number.isInteger(Number(id)) ||
                Number(id) <= 0 ||
                !Number.isInteger(quantity) ||
                quantity <= 0 ||
                counts[id] !== quantity
            ) {
                return response.status(400).json({ error: "Lesson quantities are invalid" });
            }
        }

        // reduce availability, only if enough spaces are left
        const done = [];
        for (const id of Object.keys(counts)) {
            const qty = counts[id];
            const result = await lessons.updateOne(
                { id: Number(id), availability: { $gte: qty } },
                { $inc: { availability: -qty } }
            );

            if (result.modifiedCount === 0) {
                // undo any lessons already reduced, then fail
                for (const d of done) {
                    await lessons.updateOne({ id: Number(d.id) }, { $inc: { availability: d.qty } });
                }
                return response.status(409).json({ error: "Lesson " + id + " does not have enough spaces left" });
            }
            done.push({ id: id, qty: qty });
        }

        const order = {
            name: name,
            phone: phone,
            lessonIds: lessonIds,
            spaces: spaces,
            createdAt: new Date().toISOString()
        };
        const saved = await db.collection("orders").insertOne(order);
        console.log("Order saved:", saved.insertedId, order);

        response.status(201).json(order);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// GET /orders - returns all saved orders
app.get("/orders", async function (request, response) {
    try {
        const results = await db.collection("orders").find({}).toArray();
        response.json(results);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// GET /orders/:_id - returns one order
app.get("/orders/:_id", async function (request, response) {
    try {
        const _id = toObjectId(request.params._id);
        if (!_id) return response.status(400).json({ error: "Invalid order id" });

        const order = await db.collection("orders").findOne({ _id: _id });
        if (!order) return response.status(404).json({ error: "Order not found" });
        response.json(order);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// DELETE /orders/:_id - deletes one order
app.delete("/orders/:_id", async function (request, response) {
    try {
        const _id = toObjectId(request.params._id);
        if (!_id) return response.status(400).json({ error: "Invalid order id" });

        const result = await db.collection("orders").deleteOne({ _id: _id });
        if (result.deletedCount === 0) return response.status(404).json({ error: "Order not found" });
        response.json(result);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

async function startServer() {
    try {
        await connectToMongoDB();
        app.listen(port, function () {
            console.log("App started on port " + port);
            console.log("working fine");
        });
    } catch (err) {
        process.exitCode = 1;
    }
}
//test
startServer();