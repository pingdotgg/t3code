#include "BackendProcess.h"

#include <QCoreApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTimer>
#include <QtLogging>

BackendProcess::BackendProcess(Options options, QObject* parent)
    : QObject(parent), m_options(std::move(options)) {
  m_process.setProcessChannelMode(QProcess::SeparateChannels);
  m_process.setReadChannel(QProcess::StandardOutput);
  connect(&m_process, &QProcess::readyReadStandardOutput, this, &BackendProcess::readStdout);
  connect(&m_process, &QProcess::readyReadStandardError, this, [this] {
    const auto text = QString::fromUtf8(m_process.readAllStandardError()).trimmed();
    if (!text.isEmpty()) {
      qInfo().noquote() << "[host]" << text;
    }
  });
  connect(&m_process, &QProcess::errorOccurred, this, [this](QProcess::ProcessError error) {
    if (error == QProcess::FailedToStart) {
      emit failed(QStringLiteral("Could not start %1 %2: %3")
                      .arg(m_options.nodeExecutable, m_options.hostEntry, m_process.errorString()));
    }
  });
  connect(&m_process, &QProcess::finished, this, [this](int exitCode, QProcess::ExitStatus status) {
    if (m_stopping) {
      return;
    }
    const QString how = status == QProcess::CrashExit ? QStringLiteral("crashed")
                                                       : QStringLiteral("normal exit");
    // A host that dies after announcing leaves the web view on a dead origin;
    // say so instead of letting the page spin on reconnects forever.
    emit failed(m_announced
                    ? QStringLiteral("Desktop host exited (code %1, %2). Restart T3 Code to reconnect.")
                          .arg(exitCode)
                          .arg(how)
                    : QStringLiteral("Desktop host exited before it was ready (code %1, %2).")
                          .arg(exitCode)
                          .arg(how));
  });
}

void BackendProcess::start() {
  QStringList arguments{m_options.hostEntry};
  arguments << m_options.hostArguments;
  m_process.start(m_options.nodeExecutable, arguments);
}

void BackendProcess::stop() {
  m_stopping = true;
  if (m_process.state() == QProcess::NotRunning) {
    return;
  }
  // Closing stdin is the host's signal that its parent is going away; it
  // tears the server down itself. Escalate only if it does not.
  m_process.closeWriteChannel();
  m_process.terminate();
  if (!m_process.waitForFinished(2000)) {
    m_process.kill();
    m_process.waitForFinished(1000);
  }
}

void BackendProcess::readStdout() {
  m_stdoutBuffer.append(m_process.readAllStandardOutput());
  int newline = -1;
  while ((newline = m_stdoutBuffer.indexOf('\n')) >= 0) {
    const QByteArray line = m_stdoutBuffer.left(newline).trimmed();
    m_stdoutBuffer.remove(0, newline + 1);
    if (!line.isEmpty()) {
      handleLine(line);
    }
  }
}

void BackendProcess::handleLine(const QByteArray& line) {
  const QJsonDocument doc = QJsonDocument::fromJson(line);
  if (!doc.isObject()) {
    qInfo().noquote() << "[host]" << QString::fromUtf8(line);
    return;
  }
  const QJsonObject message = doc.object();
  const QString type = message.value(QStringLiteral("type")).toString();
  if (type == QStringLiteral("ready") && !m_announced) {
    const QUrl url(message.value(QStringLiteral("url")).toString());
    if (!url.isValid()) {
      emit failed(QStringLiteral("Desktop host announced an invalid URL."));
      return;
    }
    m_announced = true;
    emit ready(url);
  } else if (type == QStringLiteral("error")) {
    emit failed(message.value(QStringLiteral("message")).toString());
  }
}
