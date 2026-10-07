-- Temporary GXClosers LMS playback fixtures.
-- These update only the original default lessons when they still have no video.
-- After deployment, Super Admin can replace or remove them and they will not be recreated.
UPDATE "SalesTrainingLesson"
SET
  "videoUrl" = 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  "videoEmbedUrl" = 'https://www.youtube.com/embed/jNQXAC9IVRw',
  "youtubeVideoId" = 'jNQXAC9IVRw',
  "description" = 'Demo video lesson for validating mobile playback and learning progress. Remove or replace it from Super Admin before launch.'
WHERE "title" = 'Welcome to GXclosers'
  AND "videoUrl" IS NULL;

UPDATE "SalesTrainingLesson"
SET
  "videoUrl" = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  "videoEmbedUrl" = 'https://www.youtube.com/embed/aqz-KE-bpKQ',
  "youtubeVideoId" = 'aqz-KE-bpKQ',
  "description" = 'Second removable demo video for testing lesson completion on Android.'
WHERE "title" = 'Price Objection Practice'
  AND "videoUrl" IS NULL;
