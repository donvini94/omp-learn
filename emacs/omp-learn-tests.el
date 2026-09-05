;;; omp-learn-tests.el --- Append safety regressions -*- lexical-binding: t; -*-
(require 'ert)
(load (expand-file-name "omp-learn.el" (file-name-directory load-file-name)) nil t)

(defmacro omp-learn-test-with-workspace (&rest body)
  `(let* ((root (make-temp-file "omp-learn-test-" t))
          (file (expand-file-name "lesson.org" root))
          (request (expand-file-name "request.json" root)))
     (unwind-protect (progn ,@body)
       (dolist (buffer (buffer-list))
         (when (and (buffer-file-name buffer)
                    (file-in-directory-p (buffer-file-name buffer) root))
           (with-current-buffer buffer
             (set-buffer-modified-p nil)
             (kill-buffer buffer))))
       (delete-directory root t))))

(defun omp-learn-test-request (request root file id text)
  (with-temp-file request
    (insert (json-encode `((learningDir . ,root) (file . ,file)
                          (kind . "log") (id . ,id) (text . ,text)
                          (preamble . "#+title: Fixture\n"))))))

(ert-deftest omp-learn-new-file-replay-preserves-learner-edits ()
  (omp-learn-test-with-workspace
   (omp-learn-test-request request root file "first"
                           "* Teacher\n:PROPERTIES:\n:OMP_EVENT_ID: first\n:END:\nOriginal explanation.\n")
   ;; A new visiting buffer has no file on disk yet. Dedup must not invoke
   ;; agenda-file handling, which prompts interactively for missing files.
   (should (alist-get 'inserted (json-parse-string (omp-learn-append-file request)
                                                 :object-type 'alist :false-object nil)))
   (with-current-buffer (find-buffer-visiting file)
     (goto-char (point-max))
     (insert "\n* Learner annotation\nMy own reasoning.\n"))
   (omp-learn-test-request request root file "second"
                           "* Teacher\n:PROPERTIES:\n:OMP_EVENT_ID: second\n:END:\nNext explanation.\n")
   (omp-learn-append-file request)
   (let ((saved (with-temp-buffer (insert-file-contents file) (buffer-string))))
     (should (string-match-p "My own reasoning" saved))
     (should (string-match-p "Original explanation" saved))
     (should (string-match-p "Next explanation" saved))
     (should-not (alist-get 'inserted (json-parse-string (omp-learn-append-file request)
                                                       :object-type 'alist :false-object nil)))
     (should (equal saved (with-temp-buffer (insert-file-contents file) (buffer-string)))))))

(ert-deftest omp-learn-unsaved-and-external-edits-refuse-export ()
  (omp-learn-test-with-workspace
   (omp-learn-test-request request root file "first"
                           "* Teacher\n:PROPERTIES:\n:OMP_EVENT_ID: first\n:END:\nOriginal.\n")
   (omp-learn-append-file request)
   (with-current-buffer (find-buffer-visiting file)
     (goto-char (point-max))
     (insert "Unsaved learner reasoning.\n"))
   (with-temp-file file (insert "External version.\n"))
   (set-file-times file (time-add (current-time) 5))
   (omp-learn-test-request request root file "second" "* Must not be appended\n")
   (should-error (omp-learn-append-file request))
   (should (equal "External version.\n" (with-temp-buffer (insert-file-contents file) (buffer-string))))
   (with-current-buffer (find-buffer-visiting file)
     (should (buffer-modified-p))
     (should (string-match-p "Unsaved learner reasoning" (buffer-string))))))
