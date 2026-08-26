#pragma once

#include <QObject>
#include <QProcess>
#include <QString>
#include <QStringList>
#include <QUrl>

// Spawns the Node desktop host and waits for its `ready` line. The shell never
// speaks to the server itself; it only needs the URL to hand to the web view.
class BackendProcess : public QObject {
  Q_OBJECT

public:
  struct Options {
    QString nodeExecutable;
    QString hostEntry;
    QStringList hostArguments;
  };

  explicit BackendProcess(Options options, QObject* parent = nullptr);

  void start();
  void stop();

signals:
  void ready(const QUrl& url);
  void failed(const QString& message);

private:
  void readStdout();
  void handleLine(const QByteArray& line);

  Options m_options;
  QProcess m_process;
  QByteArray m_stdoutBuffer;
  bool m_announced = false;
};
