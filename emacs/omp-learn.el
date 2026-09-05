;;; omp-learn.el --- Render and persist OMP lessons -*- lexical-binding: t; -*-

(require 'org)
(require 'json)
(require 'autorevert)

(defun omp-learn--refresh ()
  "Refresh lesson previews without evaluating Org source blocks."
  (when (derived-mode-p 'org-mode)
    (org-display-inline-images)
    (let ((org-confirm-babel-evaluate t))
      (org-latex-preview '(16)))))

(define-minor-mode omp-learn-log-mode
  "Read an OMP-generated lesson with inline images and mathematical notation."
  :lighter " Lesson"
  (if omp-learn-log-mode
      (progn
        (auto-revert-mode 1)
        (add-hook 'after-revert-hook #'omp-learn--refresh nil t)
        (omp-learn--refresh))
    (remove-hook 'after-revert-hook #'omp-learn--refresh t)))

(defun omp-learn--has-entry (property value)
  "Find an entry with direct PROPERTY equal to VALUE in the current buffer."
  (org-with-wide-buffer
   (let (found)
     (org-map-entries
      (lambda ()
        (when (equal (org-entry-get nil property nil) value)
          (setq found t)))
      nil nil)
     found)))

(defun omp-learn--prepare-buffer (file)
  "Visit FILE while protecting unsaved edits and external modifications."
  (let ((buffer (find-buffer-visiting file)))
    (when (and buffer (not (verify-visited-file-modtime buffer)))
      (with-current-buffer buffer
        (if (buffer-modified-p)
            (error "Save or reconcile external changes to %s before exporting" file)
          (revert-buffer t t))))
    (or buffer (find-file-noselect file))))

(defun omp-learn-append-file (request-file)
  "Apply a JSON append request from REQUEST-FILE and return only insertion status."
  (let* ((request (with-temp-buffer
                    (insert-file-contents request-file)
                    (json-parse-buffer :object-type 'alist :array-type 'list)))
         (file (file-truename (alist-get 'file request)))
         (root (file-name-as-directory (file-truename (alist-get 'learningDir request))))
         (anki (alist-get 'ankiFile request))
         (kind (alist-get 'kind request))
         (id (alist-get 'id request))
         (text (alist-get 'text request))
         (heading (alist-get 'heading request))
         (property (if (equal kind "anki") "OMP_QUIZ_ID" "OMP_EVENT_ID")))
    (unless (and (stringp id) (> (length id) 0) (stringp text)
                 (member kind '("log" "anki")))
      (error "Malformed OMP append request"))
    (unless (if (equal kind "anki")
                (and anki (equal file (file-truename anki)))
              (and (string-suffix-p ".org" file) (file-in-directory-p file root)))
      (error "OMP append target is outside its authorized destination"))
    (when (and (equal kind "anki")
               (not (and (stringp heading) (> (length heading) 0)
                         (not (string-match-p "[\n\r]" heading)))))
      (error "Anki export requires one top-level destination heading"))
    (make-directory (file-name-directory file) t)
    (let* ((new-file (not (file-exists-p file)))
           (buffer (omp-learn--prepare-buffer file))
           inserted)
      (with-current-buffer buffer
        (unless (derived-mode-p 'org-mode) (org-mode))
        (org-with-wide-buffer
         (unless (omp-learn--has-entry property id)
           (atomic-change-group
             (when (and new-file (= (buffer-size) 0))
               (insert (or (alist-get 'preamble request) "")))
             (if (equal kind "anki")
                 (progn
                   (goto-char (point-min))
                   (unless (re-search-forward
                            (concat "^\\* " (regexp-quote heading) "[ \t]*$") nil t)
                     (goto-char (point-max))
                     (unless (bolp) (insert "\n"))
                     (insert "* " heading "\n"))
                   (org-back-to-heading t)
                   (org-end-of-subtree t t))
               (goto-char (point-max)))
             (unless (bolp) (insert "\n"))
             (insert "\n" text)
             (unless (bolp) (insert "\n")))
           (setq inserted t))
         ;; A failed earlier save can leave the entry in an unsaved buffer.
         ;; Save even when dedup found it, so a retry completes persistence.
         (when (buffer-modified-p) (save-buffer)))
        (when (equal kind "log")
          (unless omp-learn-log-mode (omp-learn-log-mode 1))
          (when inserted (omp-learn--refresh))))
      (json-encode `((inserted . ,(if inserted t :json-false)))))))

(defun omp-learn-open (file)
  "Display generated lesson FILE in Emacs."
  (find-file-other-window file)
  (omp-learn-log-mode 1)
  (goto-char (point-max))
  t)

(provide 'omp-learn)
;;; omp-learn.el ends here
