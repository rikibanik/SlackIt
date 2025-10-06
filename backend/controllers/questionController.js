const Question = require('../models/Question');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { processMentions } = require('../services/mentionService');
const { s3Uploadv3 } = require('../services/s3Services');
// @desc    Create a new question
// @route   POST /api/questions
// @access  Private
const createQuestion = async (req, res) => {
    try {
        const { title, description, tags } = req.body;

        // Create question
        const question = await Question.create({
            title,
            description,
            tags,
            user: req.user._id,
        });

        // Process mentions in the question description
        await processMentions(
            description,
            req.user._id,
            req.user.username,
            question._id,
            null,
            'question'
        );

        res.status(201).json(question);
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// @desc    Get all questions
// @route   GET /api/questions
// @access  Public
const getQuestions = async (req, res) => {
    try {
        const pageSize = 10;
        const page = Number(req.query.page) || 1;
        const keyword = req.query.keyword
            ? {
                title: {
                    $regex: req.query.keyword,
                    $options: 'i',
                },
            }
            : {};

        const tag = req.query.tag ? { tags: req.query.tag } : {};

        const count = await Question.countDocuments({ ...keyword, ...tag });

        const questions = await Question.find({ ...keyword, ...tag })
            .populate('user', 'username avatar')
            .populate('upvotes', 'username avatar')
            .populate('downvotes', 'username avatar')
            .sort({ createdAt: -1 })
            .limit(pageSize)
            .skip(pageSize * (page - 1));

        res.json({
            questions,
            page,
            pages: Math.ceil(count / pageSize),
        });
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// @desc    Get question by ID
// @route   GET /api/questions/:id
// @access  Public
const getQuestionById = async (req, res) => {
    try {
        const question = await Question.findById(req.params.id)
            .populate('user', 'username avatar')
            .populate('upvotes', 'username avatar')
            .populate('downvotes', 'username avatar')
            .populate({
                path: 'answers',
                populate: [
                    {
                        path: 'user',
                        select: 'username avatar',
                    },
                    {
                        path: 'upvotes',
                        select: 'username avatar',
                    },
                    {
                        path: 'downvotes',
                        select: 'username avatar',
                    }
                ],
                options: { sort: { voteCount: -1 } },
            });

        if (question) {
            // Increment view count
            question.views += 1;
            await question.save();

            res.json(question);
        } else {
            res.status(404);
            throw new Error('Question not found');
        }
    } catch (error) {
        res.status(404).json({ message: error.message });
    }
};

// @desc    Update a question
// @route   PUT /api/questions/:id
// @access  Private
const updateQuestion = async (req, res) => {
    try {
        const { title, description, tags } = req.body;

        const question = await Question.findById(req.params.id);

        if (question) {
            // Check if user is the owner of the question
            if (question.user.toString() !== req.user._id.toString()) {
                res.status(401);
                throw new Error('Not authorized to update this question');
            }

            // Store old description to check for new mentions
            const oldDescription = question.description;

            question.title = title || question.title;
            question.description = description || question.description;
            question.tags = tags || question.tags;

            const updatedQuestion = await question.save();

            // If description was updated, process new mentions
            if (description && description !== oldDescription) {
                await processMentions(
                    description,
                    req.user._id,
                    req.user.username,
                    question._id,
                    null,
                    'question'
                );
            }

            res.json(updatedQuestion);
        } else {
            res.status(404);
            throw new Error('Question not found');
        }
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// @desc    Delete a question
// @route   DELETE /api/questions/:id
// @access  Private
const deleteQuestion = async (req, res) => {
    try {
        const question = await Question.findById(req.params.id);

        if (question) {
            // Check if user is the owner of the question or an admin
            if (
                question.user.toString() !== req.user._id.toString() &&
                req.user.role !== 'admin'
            ) {
                res.status(401);
                throw new Error('Not authorized to delete this question');
            }

            await question.remove();
            res.json({ message: 'Question removed' });
        } else {
            res.status(404);
            throw new Error('Question not found');
        }
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

// @desc    Vote on a question
// @route   PUT /api/questions/:id/vote
// @access  Private
const voteQuestion = async (req, res) => {
    try {
        const { voteType } = req.body; // 'upvote' or 'downvote'
        const question = await Question.findById(req.params.id);

        if (question) {
            const upvoteExists = question.upvotes.find(
                (upvote) => upvote.toString() === req.user._id.toString()
            );

            const downvoteExists = question.downvotes.find(
                (downvote) => downvote.toString() === req.user._id.toString()
            );

            // Handle upvote
            if (voteType === 'upvote') {
                if (downvoteExists) {
                    // Remove from downvotes if exists
                    question.downvotes = question.downvotes.filter(
                        (downvote) => downvote.toString() !== req.user._id.toString()
                    );
                }

                if (!upvoteExists) {
                    question.upvotes.push(req.user._id);
                } else {
                    // Remove upvote if already voted (toggle)
                    question.upvotes = question.upvotes.filter(
                        (upvote) => upvote.toString() !== req.user._id.toString()
                    );
                }
            }

            // Handle downvote
            if (voteType === 'downvote') {
                if (upvoteExists) {
                    // Remove from upvotes if exists
                    question.upvotes = question.upvotes.filter(
                        (upvote) => upvote.toString() !== req.user._id.toString()
                    );
                }

                if (!downvoteExists) {
                    question.downvotes.push(req.user._id);
                } else {
                    // Remove downvote if already voted (toggle)
                    question.downvotes = question.downvotes.filter(
                        (downvote) => downvote.toString() !== req.user._id.toString()
                    );
                }
            }

            // Update vote count
            await question.updateVoteCount();

            // Update user reputation
            const questionOwner = await User.findById(question.user);
            if (questionOwner) {
                if (voteType === 'upvote' && !upvoteExists) {
                    questionOwner.reputation += 5;
                } else if (voteType === 'downvote' && !downvoteExists) {
                    questionOwner.reputation = Math.max(0, questionOwner.reputation - 2);
                }
                await questionOwner.save();
            }

            const updatedQuestion = await Question.findById(req.params.id)
                .populate('user', 'username avatar')
                .populate('upvotes', 'username avatar')
                .populate('downvotes', 'username avatar');

            res.json(updatedQuestion);
        } else {
            res.status(404);
            throw new Error('Question not found');
        }
    } catch (error) {
        res.status(400).json({ message: error.message });
    }
};

const addImage = async (req, res) => {
    console.log("adding")
    if (!req.file) {
        console.log("Error 1");
        return res.status(400).json({ error: "Image file is required" });
    }
    try {
        console.log("adding2")
        const imgData = await s3Uploadv3(req.file);
        console.log("adding3")
        // If the structure has a 'Location' key, it should be accessed here
        const imgLink = imgData.Location || imgData.result?.Location;

        if (!imgLink) {
            return res.status(500).json({ error: "Failed to retrieve image link from S3" });
        }
        res.json({ link: imgLink });

    } catch (e) {
        console.error("Error uploading :", error);
        res.status(500).json({ error: "Failed to upload " });
    }
};
module.exports = {
    createQuestion,
    getQuestions,
    getQuestionById,
    updateQuestion,
    deleteQuestion,
    voteQuestion,
    addImage
}; 