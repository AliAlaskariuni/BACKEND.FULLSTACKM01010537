// reads config.env so the mongo link isnt written in the code
require("dotenv").config({ path: "./config.env" });
// normal mongodb driver
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);
let db; // gets filled in once we connect

// connects to my lesson_store database on atlas
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

var express = require("express");
// render gives its own port, 3000 is for running it on my laptop
const port = process.env.PORT || 3000;
var app = express();
var cors = require("cors");


// logger so i can see every request in the terminal, has to be above the routes
app.use(function (request, response, next) {
    console.log("Incoming " + request.method + " request for " + request.url);
    next();
});

// lets github pages talk to the server since its a different site
app.use(cors());
// so request.body works when json gets sent
app.use(express.json());
// sends the lesson pictures from the images folder
app.use("/images", express.static(path.join(__dirname, "images")));
// only reaches here if the picture wasnt found
app.use("/images", function (request, response) {
    response.status(404).json({ error: "Image not found" });
});

// LESSON ROUTES

// all the lessons, the front end calls this when the page loads
app.get("/lessons", async function (request, response) {
    try {
        const results = await db.collection("lessons").find({}).toArray(); // {} = get everything
        response.json(results);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// search route, checks subject, location, price and spaces
app.get("/search", async function (request, response) {
    try {
        // e.g. /search?q=lab gives "lab"
        const searchTerm = String(request.query.q || "").trim();

        // nothing typed so just send all the lessons
        if (searchTerm === "") {
            const results = await db.collection("lessons").find({}).toArray();
            return response.json(results);
        }

        // typing . or * used to break the search so this escapes them
        const escapedSearchTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const results = await db.collection("lessons").find({
            // a lesson comes back if any of these match
            $or: [
                { subject: new RegExp(escapedSearchTerm, "i") }, // "i" ignores capitals
                { location: new RegExp(escapedSearchTerm, "i") },
                {
                    $expr: {
                        $regexMatch: {
                            // price is a number so it gets turned into text first
                            input: { $toString: { $ifNull: ["$price", ""] } },
                            regex: escapedSearchTerm, // so "10" would find a lesson costing 100
                            options: "i"
                        }
                    }
                },
                {
                    // same again but for spaces
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

// teachers and the lessons they teach
app.get("/teachers", async function (request, response) {
    try {
        const results = await db.collection("teachers")
            .find({})
            .sort({ lastName: 1, firstName: 1 }) // surname then first name, 1 = a to z
            .toArray();
        response.json(results);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// mongo stores _id as an ObjectId, so the text from the url needs converting
function toObjectId(id) {
    // "65a1f3c2e4b0a1b2c3d4e5f6" works, something like "abc" gives null
    return ObjectId.isValid(id) && String(new ObjectId(id)) === id ? new ObjectId(id) : null;
}

// one lesson by its mongo id
app.get("/lessons/:_id", async function (request, response) {
    try {
        const _id = toObjectId(request.params._id);
        if (!_id) return response.status(400).json({ error: "Invalid lesson id" });

        const lesson = await db.collection("lessons").findOne({ _id: _id });
        // the id was fine but no lesson has it
        if (!lesson) return response.status(404).json({ error: "Lesson not found" });
        response.json(lesson);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// update a lesson, works for any field you send
app.put("/lessons/:_id", async function (request, response) {
    try {
        const _id = toObjectId(request.params._id);
        if (!_id) return response.status(400).json({ error: "Invalid lesson id" });

        const updates = Object.assign({}, request.body); // copy so the original isnt touched
        delete updates._id; // nobody should be able to change the _id
        if (Object.keys(updates).length === 0) {
            return response.status(400).json({ error: "Nothing to update" });
        }

        // e.g. sending { availability: 3 } only changes spaces, everything else stays
        const result = await db.collection("lessons").updateOne({ _id: _id }, { $set: updates });
        if (result.matchedCount === 0) return response.status(404).json({ error: "Lesson not found" });
        response.json(result);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// puts every lesson back to 5 spaces, called whenever the site opens
app.post("/lessons/reset", async function (request, response) {
    try {
        await db.collection("lessons").updateMany({}, { $set: { availability: 5 } });
        response.json({ message: "Lesson availability reset" });
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// ORDER ROUTES

// checkout sends the order here
app.post("/orders", async function (request, response) {
    try {
        // e.g. { name: "Ali", phone: "07123456789", lessonIds: [1, 1, 3], spaces: { 1: 2, 3: 1 } }
        const { name, phone, lessonIds, spaces } = request.body;

        // the website checks these too, but someone could skip it and use postman
        if (
            typeof name !== "string" ||
            !/^[A-Za-z]+$/.test(name) || // "ali123" fails here
            typeof phone !== "string" ||
            !/^\d{11}$/.test(phone) || // so does a 9 digit number
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

        // count each id so i can compare it with spaces, [1, 1, 3] becomes { 1: 2, 3: 1 }
        const counts = {};
        lessonIds.forEach(function (id) {
            counts[id] = (counts[id] || 0) + 1;
        });

        // if the cart had lessons 1 and 3 but spaces only has lesson 1, reject it
        const spaceIds = Object.keys(spaces);
        if (spaceIds.length === 0 || spaceIds.length !== Object.keys(counts).length) {
            return response.status(400).json({ error: "Lesson quantities do not match the cart" });
        }

        // each quantity has to be a whole number that matches the count
        for (const id of spaceIds) {
            const quantity = spaces[id];
            if (
                !Number.isInteger(Number(id)) ||
                Number(id) <= 0 ||
                !Number.isInteger(quantity) ||
                quantity <= 0 ||
                counts[id] !== quantity // e.g. { 1: 5 } when lesson 1 is only in the cart twice
            ) {
                return response.status(400).json({ error: "Lesson quantities are invalid" });
            }
        }

        // everything checks out so now the spaces get taken off
        const done = []; // remembers what's been taken off in case it needs undoing
        for (const id of Object.keys(counts)) {
            const qty = counts[id];
            const result = await lessons.updateOne(
                { id: Number(id), availability: { $gte: qty } }, // only matches if there's enough spaces
                { $inc: { availability: -qty } } // e.g. 5 spaces, book 2, goes down to 3
            );

            // nothing changed so this lesson didnt have enough spaces
            if (result.modifiedCount === 0) {
                // give back spaces to the lessons already done so nothing is half booked
                for (const d of done) {
                    await lessons.updateOne({ id: Number(d.id) }, { $inc: { availability: d.qty } });
                }
                return response.status(409).json({ error: "Lesson " + id + " does not have enough spaces left" });
            }
            done.push({ id: id, qty: qty });
        }

        // after that you just save the actual order
        const order = {
            name: name,
            phone: phone,
            lessonIds: lessonIds,
            spaces: spaces,
            createdAt: new Date().toISOString() // e.g. "2026-11-24T14:30:00.000Z"
        };
        const saved = await db.collection("orders").insertOne(order);
        // shows in the render logs so i can see orders coming through
        console.log("Order saved:", saved.insertedId, order);

        response.status(201).json(order); // 201 = created
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// all the orders, mainly for checking in postman
app.get("/orders", async function (request, response) {
    try {
        const results = await db.collection("orders").find({}).toArray();
        response.json(results);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});

// look up one order by its id
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

// delete an order, handy for clearing out test orders
app.delete("/orders/:_id", async function (request, response) {
    try {
        const _id = toObjectId(request.params._id);
        if (!_id) return response.status(400).json({ error: "Invalid order id" });

        const result = await db.collection("orders").deleteOne({ _id: _id });
        // nothing deleted means that id didnt exist
        if (result.deletedCount === 0) return response.status(404).json({ error: "Order not found" });
        response.json(result);
    } catch (err) {
        console.error(err);
        response.status(500).json({ error: err.message });
    }
});


// connects to mongo first, no point taking requests without the database
async function startServer() {
    try {
        await connectToMongoDB();
        app.listen(port, function () {
            console.log("App started on port " + port);
            console.log("working fine");
        });
    } catch (err) {
        process.exitCode = 1; // mongo didnt connect so exit with an error
    }
}

startServer();
